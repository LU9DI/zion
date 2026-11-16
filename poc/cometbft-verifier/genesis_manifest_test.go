package verifier

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
)

func testGenesisGovernorKey(t *testing.T, domain byte) (ed25519.PublicKey, ed25519.PrivateKey, GenesisGovernor) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate governor key: %v", err)
	}
	governor := GenesisGovernor{}
	copy(governor.PublicKey[:], publicKey)
	domainDigest := sha256.Sum256([]byte{domain})
	governor.ControlDomainDigest = domainDigest
	return publicKey, privateKey, governor
}

func testGenesisManifest(t *testing.T, governors int, threshold uint16) (GenesisManifest, []ed25519.PrivateKey) {
	t.Helper()
	manifest := GenesisManifest{
		ProjectID:     "project-alpha",
		ChainID:       "zion-genesis-test-1",
		InitialHeight: 1,
		Threshold:     threshold,
	}
	for i := range manifest.GenesisNonce {
		manifest.GenesisNonce[i] = 0x10
	}
	for i := range manifest.AppGenesisDigest {
		manifest.AppGenesisDigest[i] = 0x20
	}
	for i := range manifest.GovernorPolicyDigest {
		manifest.GovernorPolicyDigest[i] = 0x30
	}
	for i := range manifest.RecoveryPolicyDigest {
		manifest.RecoveryPolicyDigest[i] = 0x40
	}
	keys := make([]ed25519.PrivateKey, governors)
	for i := 0; i < governors; i++ {
		_, privateKey, governor := testGenesisGovernorKey(t, byte(i+1))
		manifest.Governors = append(manifest.Governors, governor)
		keys[i] = privateKey
	}
	return manifest, keys
}

func signWith(t *testing.T, manifest GenesisManifest, keys []ed25519.PrivateKey, indices ...int) []GenesisSignature {
	t.Helper()
	signatures := make([]GenesisSignature, 0, len(indices))
	for _, index := range indices {
		signature, err := SignGenesisManifest(manifest, keys[index])
		if err != nil {
			t.Fatalf("sign genesis manifest with governor %d: %v", index, err)
		}
		signatures = append(signatures, signature)
	}
	return signatures
}

func TestGenesisManifestRoundTripAndIsolation(t *testing.T) {
	manifest, _ := testGenesisManifest(t, 3, 2)
	encoded, err := EncodeGenesisManifest(manifest)
	if err != nil {
		t.Fatalf("encode manifest: %v", err)
	}
	decoded, err := DecodeGenesisManifest(encoded)
	if err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if decoded.ProjectID != manifest.ProjectID || decoded.ChainID != manifest.ChainID ||
		decoded.Threshold != manifest.Threshold || len(decoded.Governors) != 3 {
		t.Fatalf("decoded manifest differs: %+v", decoded)
	}
	decoded.Governors[0].PublicKey[0] ^= 0xff
	if manifest.Governors[0].PublicKey[0] == decoded.Governors[0].PublicKey[0] {
		t.Fatal("decoder aliased caller-owned governor keys")
	}
	again, err := EncodeGenesisManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, again) {
		t.Fatal("manifest encoding is not deterministic")
	}
}

func TestGenesisManifestCanonicalGoldenVector(t *testing.T) {
	manifest := GenesisManifest{
		ProjectID:     "p",
		ChainID:       "c",
		InitialHeight: 1,
		Threshold:     1,
	}
	for i := range manifest.GenesisNonce {
		manifest.GenesisNonce[i] = 0x11
	}
	for i := range manifest.AppGenesisDigest {
		manifest.AppGenesisDigest[i] = 0x22
	}
	for i := range manifest.GovernorPolicyDigest {
		manifest.GovernorPolicyDigest[i] = 0x33
	}
	for i := range manifest.RecoveryPolicyDigest {
		manifest.RecoveryPolicyDigest[i] = 0x44
	}
	governor := GenesisGovernor{}
	for i := range governor.PublicKey {
		governor.PublicKey[i] = 0x55
	}
	for i := range governor.ControlDomainDigest {
		governor.ControlDomainDigest[i] = 0x66
	}
	manifest.Governors = []GenesisGovernor{governor}
	encoded, err := EncodeGenesisManifest(manifest)
	if err != nil {
		t.Fatalf("encode golden manifest: %v", err)
	}
	const expected = "5a474e3100010001000000fe000170111111111111111111111111111111111111111111111111111111111111111100016300000000000000012222222222222222222222222222222222222222222222222222222222222222333333333333333333333333333333333333333333333333333333333333333344444444444444444444444444444444444444444444444444444444444444440001555555555555555555555555555555555555555555555555555555555555555566666666666666666666666666666666666666666666666666666666666666660001faa2d852b46be7330b8a6c5ad7e846d50827dd05f5d87d0121d662e5126c6c61"
	if got := hex.EncodeToString(encoded); got != expected {
		t.Fatalf("canonical genesis manifest vector changed:\n got %s\nwant %s", got, expected)
	}
	digest, err := GenesisManifestDigest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	const expectedDigest = "bf9ba23d9c82cafc29d92ec63aa03175170367fafe37e778a1a62289c5c25980"
	if got := hex.EncodeToString(digest[:]); got != expectedDigest {
		t.Fatalf("genesis manifest digest changed: got %s", got)
	}
}

func TestGenesisManifestRejectsInvalidFields(t *testing.T) {
	base, _ := testGenesisManifest(t, 3, 2)
	tests := []struct {
		name   string
		mutate func(*GenesisManifest)
		want   error
	}{
		{"empty project", func(m *GenesisManifest) { m.ProjectID = "" }, ErrGenesisManifestInvalid},
		{"empty chain ID", func(m *GenesisManifest) { m.ChainID = "" }, ErrGenesisManifestInvalid},
		{"oversized chain ID", func(m *GenesisManifest) { m.ChainID = string(bytes.Repeat([]byte("c"), 51)) }, ErrGenesisManifestInvalid},
		{"zero nonce", func(m *GenesisManifest) { m.GenesisNonce = [walDigestSize]byte{} }, ErrGenesisManifestInvalid},
		{"zero app genesis digest", func(m *GenesisManifest) { m.AppGenesisDigest = [walDigestSize]byte{} }, ErrGenesisManifestInvalid},
		{"zero governor policy digest", func(m *GenesisManifest) { m.GovernorPolicyDigest = [walDigestSize]byte{} }, ErrGenesisManifestInvalid},
		{"zero recovery policy digest", func(m *GenesisManifest) { m.RecoveryPolicyDigest = [walDigestSize]byte{} }, ErrGenesisManifestInvalid},
		{"zero threshold", func(m *GenesisManifest) { m.Threshold = 0 }, ErrGenesisThreshold},
		{"threshold above governor count", func(m *GenesisManifest) { m.Threshold = 4 }, ErrGenesisThreshold},
		{"no governors", func(m *GenesisManifest) { m.Governors = nil; m.Threshold = 1 }, ErrGenesisManifestInvalid},
		{"duplicate governor key", func(m *GenesisManifest) {
			m.Governors[2] = m.Governors[1]
		}, ErrGenesisDuplicateGovernor},
		{"zero governor control domain", func(m *GenesisManifest) {
			m.Governors[0].ControlDomainDigest = [walDigestSize]byte{}
		}, ErrGenesisManifestInvalid},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manifest := base
			manifest.Governors = append([]GenesisGovernor(nil), base.Governors...)
			tt.mutate(&manifest)
			if _, err := EncodeGenesisManifest(manifest); !errors.Is(err, tt.want) {
				t.Fatalf("encode error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestGenesisManifestRejectsTooManyGovernors(t *testing.T) {
	manifest, _ := testGenesisManifest(t, 1, 1)
	manifest.Governors = make([]GenesisGovernor, MaxGenesisGovernors+1)
	for i := range manifest.Governors {
		manifest.Governors[i].PublicKey[0] = byte(i)
		manifest.Governors[i].PublicKey[1] = 0x01
		manifest.Governors[i].ControlDomainDigest[0] = byte(i)
		manifest.Governors[i].ControlDomainDigest[1] = 0x02
	}
	manifest.Threshold = 1
	if _, err := EncodeGenesisManifest(manifest); !errors.Is(err, ErrGenesisManifestBounds) {
		t.Fatalf("oversized governor set error = %v, want ErrGenesisManifestBounds", err)
	}
}

func TestGenesisManifestDecoderRejectsTruncationAndTampering(t *testing.T) {
	manifest, _ := testGenesisManifest(t, 2, 2)
	encoded, err := EncodeGenesisManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < len(encoded); i++ {
		if _, err := DecodeGenesisManifest(encoded[:i]); err == nil {
			t.Fatalf("truncated manifest of %d/%d bytes unexpectedly decoded", i, len(encoded))
		}
	}
	if _, err := DecodeGenesisManifest(append(append([]byte(nil), encoded...), 0x00)); err == nil {
		t.Fatal("manifest with a trailing byte unexpectedly decoded")
	}
	tampered := append([]byte(nil), encoded...)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := DecodeGenesisManifest(tampered); !errors.Is(err, ErrGenesisChecksum) {
		t.Fatalf("tampered manifest error = %v, want ErrGenesisChecksum", err)
	}
	tampered = append([]byte(nil), encoded...)
	tampered[0] ^= 0xff
	if _, err := DecodeGenesisManifest(tampered); !errors.Is(err, ErrGenesisManifestInvalid) {
		t.Fatalf("wrong magic error = %v, want ErrGenesisManifestInvalid", err)
	}
}

func TestGenesisAcceptanceRequiresDistinctGovernorSignatures(t *testing.T) {
	manifest, keys := testGenesisManifest(t, 4, 3)
	signatures := signWith(t, manifest, keys, 0, 1, 2)
	accepted, err := VerifyGenesisAcceptance(manifest, signatures, GenesisAcceptancePolicy{RequiredSignatures: 3})
	if err != nil {
		t.Fatalf("valid genesis acceptance rejected: %v", err)
	}
	if accepted.ProjectID != manifest.ProjectID || accepted.ChainID != manifest.ChainID {
		t.Fatalf("accepted genesis context differs: %+v", accepted)
	}
	if len(accepted.Signers) != 3 || accepted.Signers[0] != 0 || accepted.Signers[1] != 1 || accepted.Signers[2] != 2 {
		t.Fatalf("unexpected signer set: %v", accepted.Signers)
	}
	digest, err := GenesisManifestDigest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.ManifestDigest != digest {
		t.Fatal("accepted digest differs from the canonical manifest digest")
	}
	if err := CheckGenesisAnchor(accepted, manifest); err != nil {
		t.Fatalf("retained anchor rejected its own manifest: %v", err)
	}
}

func TestGenesisAcceptanceFailsClosed(t *testing.T) {
	manifest, keys := testGenesisManifest(t, 4, 3)
	_, unrelatedPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	outsiderSignature, err := SignGenesisManifest(manifest, unrelatedPrivate)
	if err != nil {
		t.Fatal(err)
	}
	tamperedManifest := manifest
	tamperedManifest.GenesisNonce[0] ^= 0xff
	wrongManifestSignature := signWith(t, tamperedManifest, keys, 0)[0]

	tests := []struct {
		name       string
		signatures []GenesisSignature
		policy     GenesisAcceptancePolicy
		want       error
	}{
		{
			name:       "unstated acceptance threshold",
			signatures: signWith(t, manifest, keys, 0, 1, 2),
			policy:     GenesisAcceptancePolicy{},
			want:       ErrGenesisThreshold,
		},
		{
			name:       "policy threshold below the manifest threshold",
			signatures: signWith(t, manifest, keys, 0, 1, 2),
			policy:     GenesisAcceptancePolicy{RequiredSignatures: 2},
			want:       ErrGenesisThreshold,
		},
		{
			name:       "policy threshold above the governor count",
			signatures: signWith(t, manifest, keys, 0, 1, 2, 3),
			policy:     GenesisAcceptancePolicy{RequiredSignatures: 5},
			want:       ErrGenesisThreshold,
		},
		{
			name:       "too few distinct signatures",
			signatures: signWith(t, manifest, keys, 0, 1),
			policy:     GenesisAcceptancePolicy{RequiredSignatures: 3},
			want:       ErrGenesisThreshold,
		},
		{
			name:       "duplicate signer",
			signatures: signWith(t, manifest, keys, 0, 0, 1, 2),
			policy:     GenesisAcceptancePolicy{RequiredSignatures: 3},
			want:       ErrGenesisDuplicateSigner,
		},
		{
			name:       "unknown signer",
			signatures: append(signWith(t, manifest, keys, 0, 1), outsiderSignature),
			policy:     GenesisAcceptancePolicy{RequiredSignatures: 3},
			want:       ErrGenesisUnauthorizedSigner,
		},
		{
			name:       "signature over another manifest",
			signatures: append(signWith(t, manifest, keys, 1, 2), wrongManifestSignature),
			policy:     GenesisAcceptancePolicy{RequiredSignatures: 3},
			want:       ErrGenesisSignature,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := VerifyGenesisAcceptance(manifest, tt.signatures, tt.policy); !errors.Is(err, tt.want) {
				t.Fatalf("acceptance error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestGenesisAcceptanceAuthorizedKeyRestriction(t *testing.T) {
	manifest, keys := testGenesisManifest(t, 4, 2)
	authorized := make([][ed25519.PublicKeySize]byte, 0, 1)
	authorized = append(authorized, manifest.Governors[3].PublicKey)
	// Governors 0 and 1 sign, but the caller only authorizes governor 3.
	if _, err := VerifyGenesisAcceptance(manifest, signWith(t, manifest, keys, 0, 1),
		GenesisAcceptancePolicy{RequiredSignatures: 2, AuthorizedKeys: authorized}); !errors.Is(err, ErrGenesisUnauthorizedSigner) {
		t.Fatalf("unauthorized signer error = %v, want ErrGenesisUnauthorizedSigner", err)
	}
	if _, err := VerifyGenesisAcceptance(manifest, signWith(t, manifest, keys, 0, 3),
		GenesisAcceptancePolicy{RequiredSignatures: 2, AuthorizedKeys: authorized}); !errors.Is(err, ErrGenesisUnauthorizedSigner) {
		t.Fatalf("partially unauthorized signer set error = %v, want ErrGenesisUnauthorizedSigner", err)
	}
	// Authorization alone never lowers the threshold.
	if _, err := VerifyGenesisAcceptance(manifest, signWith(t, manifest, keys, 3),
		GenesisAcceptancePolicy{RequiredSignatures: 2, AuthorizedKeys: authorized}); !errors.Is(err, ErrGenesisThreshold) {
		t.Fatalf("insufficient authorized signatures error = %v, want ErrGenesisThreshold", err)
	}
}

func TestGenesisConflictDetection(t *testing.T) {
	manifest, keys := testGenesisManifest(t, 3, 2)
	accepted, err := VerifyGenesisAcceptance(manifest, signWith(t, manifest, keys, 0, 1),
		GenesisAcceptancePolicy{RequiredSignatures: 2})
	if err != nil {
		t.Fatalf("accept genesis: %v", err)
	}
	conflicting := manifest
	conflicting.GenesisNonce[0] = 0xff
	if err := CheckGenesisAnchor(accepted, conflicting); !errors.Is(err, ErrGenesisConflict) {
		t.Fatalf("conflicting manifest error = %v, want ErrGenesisConflict", err)
	}
	otherProject := manifest
	otherProject.ProjectID = "project-beta"
	if err := CheckGenesisAnchor(accepted, otherProject); !errors.Is(err, ErrGenesisConflict) {
		t.Fatalf("other project manifest error = %v, want ErrGenesisConflict", err)
	}
	conflictingDigestA, err := GenesisManifestDigest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	conflictingDigestB, err := GenesisManifestDigest(conflicting)
	if err != nil {
		t.Fatal(err)
	}
	if conflictingDigestA == conflictingDigestB {
		t.Fatal("two different manifests produced the same digest")
	}
}
