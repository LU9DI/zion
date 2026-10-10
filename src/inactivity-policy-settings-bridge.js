import { inactivitySettingsToPolicyOptions } from './inactivity-settings-service.js';

/**
 * Applies the authenticated owner's saved settings to a running policy instance.
 * It is intentionally explicit: saving preferences alone does not mutate a node.
 * The host supplies a short-lived access token provider and the expected owner ID.
 */
export class InactivityPolicySettingsBridge {
  constructor({ settingsService, policy, ownerIdentityId, getAccessToken } = {}) {
    if (!settingsService || typeof settingsService.getSettings !== 'function' ||
        !policy || typeof policy.updateOptions !== 'function' ||
        typeof ownerIdentityId !== 'string' || !ownerIdentityId.trim() ||
        typeof getAccessToken !== 'function') {
      throw new TypeError('Invalid inactivity policy settings bridge configuration');
    }
    this.settingsService = settingsService;
    this.policy = policy;
    this.ownerIdentityId = ownerIdentityId;
    this.getAccessToken = getAccessToken;
    this.lastApplied = null;
    this.lastError = null;
  }

  async applySavedSettings() {
    try {
      const token = await this.getAccessToken();
      if (typeof token !== 'string' || !token.trim()) {
        const error = new Error('Owner authentication is required to apply inactivity settings');
        error.code = 'AUTH_REQUIRED';
        throw error;
      }
      const response = await this.settingsService.getSettings(token);
      if (response?.identityId !== this.ownerIdentityId) {
        const error = new Error('Authenticated identity does not own this node');
        error.code = 'OWNER_MISMATCH';
        throw error;
      }
      if (!response.settings || typeof response.settings !== 'object') throw new Error('Settings service returned an invalid response');
      const options = inactivitySettingsToPolicyOptions(response.settings);
      const result = this.policy.updateOptions(options);
      this.lastApplied = Object.freeze({ at: Date.now(), identityId: this.ownerIdentityId,
        source: response.source ?? 'account', options: result.options });
      this.lastError = null;
      return Object.freeze({ ok: true, appliedToNode: true, identityId: this.ownerIdentityId,
        source: this.lastApplied.source, options: result.options });
    } catch (error) {
      this.lastError = Object.freeze({ code: String(error?.code || 'SETTINGS_APPLY_FAILED'),
        message: String(error?.message || 'Unable to apply inactivity settings').slice(0, 240) });
      return Object.freeze({ ok: false, appliedToNode: false, error: this.lastError });
    }
  }

  snapshot() {
    return Object.freeze({ applied: this.lastApplied, error: this.lastError,
      currentPolicyOptions: this.policy.snapshot?.().options ?? null });
  }
}
