'use strict';
(() => {
  const demoFiles = [
    {name:'Zion Project.pdf',type:'documento',size:2480000,modified:'Today, 09:42',icon:'PDF'},
    {name:'Travel photos.zip',type:'imagem',size:186000000,modified:'Yesterday, 18:20',icon:'▧'},
    {name:'Meeting notes.docx',type:'documento',size:420000,modified:'Yesterday, 02:08 PM',icon:'W'},
    {name:'Presentation.pptx',type:'documento',size:5200000,modified:'Oct 8, 2026',icon:'P'},
    {name:'Demo video.mp4',type:'video',size:84000000,modified:'Oct 7, 2026',icon:'▶'},
    {name:'Budget.xlsx',type:'documento',size:930000,modified:'Oct 6, 2026',icon:'X'},
    {name:'Logo Zion.svg',type:'imagem',size:78000,modified:'Oct 5, 2026',icon:'◇'},
    {name:'Archive.tar',type:'outro',size:12300000,modified:'Oct 3, 2026',icon:'▤'}
  ];
  const demoActivity = [
    {icon:'↥',title:'File added',detail:'Zion Project.pdf was added to the preview.',time:'Today, 09:42'},
    {icon:'◉',title:'Network status checked',detail:'Illustrative summary of 3 nodes.',time:'Today, 09:30'},
    {icon:'▤',title:'File opened',detail:'Meeting notes.docx was opened in the preview.',time:'Yesterday, 02:08 PM'},
    {icon:'✓',title:'Sample check',detail:'No fictional alerts recorded in this demo.',time:'Oct 8, 2026'}
  ];
  let files = [...demoFiles];
  let activity = [...demoActivity];
  let gridView = false;
  const $ = (id) => document.getElementById(id);
  const safe = (value) => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmtSize = bytes => bytes >= 1e9 ? `${(bytes/1e9).toFixed(1).replace('.',',')} GB` : bytes >= 1e6 ? `${(bytes/1e6).toFixed(bytes >= 1e8 ? 0 : 1).replace('.',',')} MB` : `${Math.max(1,Math.round(bytes/1000))} KB`;
  const fileClass = f => f.type === 'imagem' ? 'image' : f.type === 'video' ? 'video' : f.type === 'outro' ? 'other' : '';
  const iconFor = f => f.icon || (f.type === 'imagem' ? '▧' : f.type === 'video' ? '▶' : f.type === 'outro' ? '▤' : 'DOC');
  function renderRecentFiles(){
    $('recent-files').innerHTML = files.slice(0,4).map(f=>`<div class="file-row"><span class="file-type-icon ${fileClass(f)}">${safe(iconFor(f))}</span><div class="file-info"><strong>${safe(f.name)}</strong><small>${safe(f.modified)}</small></div><span class="file-size">${fmtSize(f.size)}</span></div>`).join('') || '<p class="subheading">No files yet.</p>';
    $('file-count').textContent = String(128 + Math.max(0, files.length - demoFiles.length));
  }
  function renderFiles(){
    const q = $('file-search').value.trim().toLocaleLowerCase('en-US');
    const type = $('file-filter').value;
    const filtered = files.filter(f => f.name.toLocaleLowerCase('en-US').includes(q) && (type === 'todos' || f.type === type));
    $('all-files').innerHTML = filtered.map((f,i)=>`<tr><td><div class="table-file-name"><span class="file-type-icon ${fileClass(f)}">${safe(iconFor(f))}</span>${safe(f.name)}</div></td><td>${safe(({documento:'Document',imagem:'Image',video:'Video',outro:'Other'})[f.type] || 'File')}</td><td>${fmtSize(f.size)}</td><td>${safe(f.modified)}</td><td><button class="row-actions" data-file-index="${files.indexOf(f)}" aria-label="Details for ${safe(f.name)}" title="Details">···</button></td></tr>`).join('');
    $('empty-files').classList.toggle('hidden', filtered.length > 0);
    $('all-files').parentElement.classList.toggle('hidden', filtered.length === 0);
    $('all-files').closest('.file-table-wrap').classList.toggle('compact', gridView);
  }
  function renderActivity(target='recent-activity', items=activity.slice(0,3)){
    $(target).innerHTML = items.map(a=>`<div class="activity-row"><span class="activity-icon">${safe(a.icon)}</span><div class="activity-copy"><strong>${safe(a.title)}</strong><p>${safe(a.detail)}</p></div><span class="activity-time">${safe(a.time)}</span></div>`).join('') || '<p class="subheading">No activity in this view.</p>';
  }
  let toastTimer;
  function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2800)}
  function go(page){
    const target = document.getElementById(`page-${page}`); if(!target) return;
    document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p===target));
    document.querySelectorAll('.nav-item[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
    $('current-crumb').textContent=target.dataset.title;
    $('sidebar').classList.remove('open');
    if(page==='arquivos') renderFiles();
    if(page==='atividade') renderActivity('all-activity',activity);
    if(page==='notificacoes') void loadNotifications();
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function addFiles(list){
    const incoming = Array.from(list || []); if(!incoming.length) return;
    const now = 'Now';
    incoming.forEach(f=>{
      const ext=(f.name.split('.').pop()||'').toLowerCase();
      const type=['png','jpg','jpeg','gif','webp','svg','heic'].includes(ext)?'imagem':['mp4','mov','webm','mkv'].includes(ext)?'video':['pdf','doc','docx','txt','md','ppt','pptx','xls','xlsx','odt','rtf'].includes(ext)?'documento':'outro';
      files.unshift({name:f.name,type,size:f.size,modified:now,icon:({pdf:'PDF',doc:'W',docx:'W',pptx:'P',xlsx:'X'})[ext] || (type==='imagem'?'▧':type==='video'?'▶':type==='outro'?'▤':'DOC')});
    });
    activity.unshift({icon:'↥',title:`${incoming.length} file${incoming.length===1?'':'s'} selected`,detail:'Added to the local view; not uploaded to the cloud.',time:now});
    renderRecentFiles();renderFiles();renderActivity();renderActivity('all-activity',activity);
    toast(`${incoming.length} file${incoming.length===1?'':'s'} added to the local preview.`);
  }
  const people = [
    {id:'ana',name:'Ana Costa',handle:'@anacosta',bio:'Design and open files',avatar:'A',tone:'teal',following:true},
    {id:'marcos',name:'Marcos Lima',handle:'@marcoslima',bio:'Distributed development',avatar:'M',tone:'',following:false},
    {id:'bia',name:'Beatriz Souza',handle:'@biasouza',bio:'Photography and community',avatar:'B',tone:'rose',following:false},
    {id:'rafa',name:'Rafael Alves',handle:'@rafaalves',bio:'Digital privacy',avatar:'R',tone:'gold',following:true}
  ];
  const conversations = new Map();
  let activeConversation = null;
  const nowLabel = () => new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  function renderPeople(){
    const query = $('people-search').value.trim().toLocaleLowerCase('en-US');
    const shown = people.filter(p => `${p.name} ${p.handle} ${p.bio}`.toLocaleLowerCase('en-US').includes(query));
    $('people-list').innerHTML = shown.map(p=>`<div class="person-row"><span class="person-avatar ${p.tone}">${safe(p.avatar)}</span><div class="person-meta"><strong>${safe(p.name)}</strong><small>${safe(p.handle)} · ${safe(p.bio)}</small></div><div class="person-actions"><button class="small-action ${p.following?'following':''}" data-follow="${safe(p.id)}" aria-pressed="${p.following}">${p.following?'Following':'＋ Follow'}</button><button class="small-action" data-message="${safe(p.id)}">Message</button></div></div>`).join('') || '<div class="social-empty">No people found. Try another search.</div>';
  }
  function renderConversations(){
    const list = people.filter(p=>conversations.has(p.id)).sort((a,b)=>{
      const am=conversations.get(a.id), bm=conversations.get(b.id);
      return (bm.at(-1)?.order||0)-(am.at(-1)?.order||0);
    });
    $('conversation-list').innerHTML = list.map(p=>{
      const msgs=conversations.get(p.id)||[], last=msgs.at(-1);
      return `<button class="conversation-row ${activeConversation===p.id?'selected':''}" data-open-chat="${safe(p.id)}"><span class="person-avatar ${p.tone}">${safe(p.avatar)}</span><span class="person-meta"><strong>${safe(p.name)}</strong><small class="conversation-preview">${safe(last?.text||'Conversation started')}</small></span><small>${safe(last?.time||'')}</small></button>`;
    }).join('') || '<div class="social-empty">You do not have any conversations yet. Use “Message” on a profile to start one.</div>';
    const count = [...conversations.values()].reduce((sum,msgs)=>sum+msgs.filter(m=>m.mine).length,0);
    $('message-count').textContent=String(count);
  }
  function openConversation(id){
    const person=people.find(p=>p.id===id); if(!person)return;
    if(!conversations.has(id)) conversations.set(id,[]);
    activeConversation=id;
    $('chat-empty').classList.add('hidden'); $('chat-thread').classList.remove('hidden');
    $('chat-person').innerHTML=`<span class="person-avatar ${person.tone}">${safe(person.avatar)}</span><span>${safe(person.name)}<small style="display:block;color:#8993a4;font-size:10px;font-weight:500">${safe(person.handle)}</small></span>`;
    const msgs=conversations.get(id);
    $('chat-messages').innerHTML=msgs.map(m=>`<div class="chat-bubble ${m.mine?'mine':''}">${safe(m.text)}<time>${safe(m.time)}${m.mine?' · sent in this preview':''}</time></div>`).join('') || '<div class="social-empty">Conversation started. Write your first message below.</div>';
    renderConversations();
    $('message-input').focus();
  }
  $('people-search').addEventListener('input',renderPeople);
  $('people-list').addEventListener('click',e=>{
    const follow=e.target.closest('[data-follow]');
    const message=e.target.closest('[data-message]');
    if(follow){const p=people.find(x=>x.id===follow.dataset.follow);if(!p)return;p.following=!p.following;renderPeople();toast(p.following?`You are now following ${p.name} in this preview.`:`You unfollowed ${p.name} in this preview.`);return;}
    if(message){openConversation(message.dataset.message);}
  });
  $('conversation-list').addEventListener('click',e=>{const b=e.target.closest('[data-open-chat]');if(b)openConversation(b.dataset.openChat);});
  $('message-form').addEventListener('submit',e=>{
    e.preventDefault(); const input=$('message-input'); const value=input.value.trim();
    if(!value||!activeConversation)return;
    const messages=conversations.get(activeConversation)||[];
    messages.push({text:value,mine:true,time:nowLabel(),order:Date.now()}); conversations.set(activeConversation,messages);
    const person=people.find(p=>p.id===activeConversation);
    activity.unshift({icon:'✉',title:'Message prepared',detail:`Message to ${person?.name||'contact'} recorded only in this local preview.`,time:'Now'});
    input.value=''; openConversation(activeConversation); renderActivity();renderActivity('all-activity',activity);
    toast('Message saved in this preview; it was not sent over the network.');
  });
  renderPeople();renderConversations();

  document.querySelectorAll('.nav-item[data-page]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page)));
  document.querySelectorAll('[data-goto]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.goto)));
  $('upload-top').addEventListener('click',()=>$('file-picker').click());
  $('upload-files').addEventListener('click',()=>$('file-picker').click());
  $('file-picker').addEventListener('change',e=>{addFiles(e.target.files);e.target.value='';});
  $('file-search').addEventListener('input',renderFiles);$('file-filter').addEventListener('change',renderFiles);
  $('view-toggle').addEventListener('click',()=>{gridView=!gridView;$('view-toggle').textContent=gridView?'☷':'▦';toast(gridView?'Compact list enabled.':'Compact list enabled.');renderFiles();});
  $('all-files').addEventListener('click',e=>{const b=e.target.closest('[data-file-index]');if(!b)return;const f=files[Number(b.dataset.fileIndex)];if(f)toast(`${f.name} · ${fmtSize(f.size)} · local demo`);});
  $('mobile-menu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  document.querySelector('.notice-close').addEventListener('click',e=>e.currentTarget.closest('.notice').remove());
  $('help-button').addEventListener('click',()=>$('help-dialog').showModal());$('close-help').addEventListener('click',()=>$('help-dialog').close());$('help-ok').addEventListener('click',()=>$('help-dialog').close());
  $('contribute-toggle').addEventListener('change',e=>{$('contribute-message').textContent=e.target.checked?'Preference enabled in the demo only. No real service was started.':'Preference disabled. No real service was started.';toast(e.target.checked?'Simulated contribution enabled.':'Simulated contribution paused.');});
  $('workspace-name').addEventListener('input',e=>document.querySelector('.profile strong').textContent=e.target.value.trim()||'My Zion');
  $('save-settings').addEventListener('click',()=>{$('settings-feedback').textContent='Preference applied in this session.';toast('Preference updated in this preview.');});
  const inactivitySettingFields = {
    pauseWarningAtDays: 'idle-pause-warning', pauseAfterDays: 'idle-pause-after',
    reductionWarningAtDays: 'idle-reduction-warning', reduceAfterDays: 'idle-reduction-after',
    reductionPercent: 'idle-reduction-percent'
  };
  const inactivityStorage = (() => { try { return window.localStorage; } catch { return null; } })();
  const inactivityAuth = window.ZionAuth && typeof window.ZionAuth.getAccessToken === 'function' ? window.ZionAuth : null;
  const inactivityApi = inactivityAuth ? window.ZionInactivitySettingsApiClient.create({
    getAccessToken: () => inactivityAuth.getAccessToken(),
    fetchImpl: window.fetch.bind(window),
    baseUrl: document.querySelector('meta[name="zion-api-base"]')?.content || '',
  }) : null;
  const notificationsApi = inactivityAuth && window.ZionInactivityNotificationsApiClient ? window.ZionInactivityNotificationsApiClient.create({
    getAccessToken: () => inactivityAuth.getAccessToken(),
    fetchImpl: window.fetch.bind(window),
    baseUrl: document.querySelector('meta[name="zion-api-base"]')?.content || '',
  }) : null;
  let notificationRecords = [];
  let notificationsLoading = false;
  const notificationTypes = {
    'pause-warning': { title: 'Inactivity pause warning', icon: '◷', style: 'warning' },
    'contribution-paused': { title: 'Contribution paused', icon: 'Ⅱ', style: 'paused' },
    'capacity-reduction-warning': { title: 'Capacity reduction warning', icon: '↓', style: 'warning' },
    'capacity-reduction-pending': { title: 'Capacity reduction pending', icon: '⌛', style: 'warning' },
    'capacity-reduced': { title: 'Contributed capacity reduced', icon: '↓', style: '' },
  };
  const notificationDate = value => {
    if (typeof value !== 'string') return 'Date unavailable';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  };
  function updateNotificationCount() {
    const count = notificationRecords.filter(item => !item.viewedAt).length;
    const badge = $('notification-nav-count');
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count === 0);
    badge.setAttribute('aria-label', `${count} unread notification${count === 1 ? '' : 's'}`);
  }
  function renderNotifications() {
    const list = $('notifications-list');
    const filter = $('notification-filter').value;
    const records = notificationRecords.filter(item => filter === 'all' || item.deliveryStatus === filter);
    if (!records.length) {
      list.innerHTML = `<div class="notification-empty">${notificationsApi ? 'No notifications in this category.' : 'Connect an authenticated session to view your real notifications.'}</div>`;
      return;
    }
    list.innerHTML = records.map(item => {
      const type = notificationTypes[item.type] || { title: 'Zion alert', icon: '•', style: '' };
      const delivery = item.deliveryStatus === 'delivered' ? 'Delivered' : 'Delivery pending';
      const unread = !item.viewedAt;
      return `<article class="notification-card"><span class="notification-symbol ${type.style}">${type.icon}</span><div class="notification-main"><strong>${safe(type.title)}</strong><p>${safe(item.message || 'Zion recorded an inactivity event.')}</p><div class="notification-meta"><span>${safe(notificationDate(item.createdAt))}</span><span class="notification-state ${item.deliveryStatus === 'delivered' ? 'delivered' : ''}">${delivery}</span><span class="notification-state ${unread ? 'unread' : ''}">${unread ? 'Unread' : 'Read'}</span></div>${unread ? `<div class="notification-actions"><button type="button" data-notification-view="${safe(item.id)}">Mark as read</button></div>` : ''}</div></article>`;
    }).join('');
  }
  async function loadNotifications() {
    const status = $('notifications-status');
    if (notificationsLoading) return;
    if (!notificationsApi) {
      status.textContent = 'Authenticated session is not configured. Real history is unavailable.';
      $('notifications-list').innerHTML = '<div class="notification-empty">This preview does not create fictional alerts. Configure ZionAuth and the notifications API to load history.</div>';
      return;
    }
    notificationsLoading = true;
    $('refresh-notifications').disabled = true;
    status.classList.remove('notification-error');
    status.textContent = 'Loading account notifications…';
    try {
      const response = await notificationsApi.list({ status: 'all', limit: 200 });
      if (!response || response.ok !== true || !Array.isArray(response.notifications)) throw new Error('Incomplete response from the notifications service.');
      notificationRecords = response.notifications.filter(item => item && typeof item.id === 'string' && typeof item.type === 'string' && typeof item.message === 'string' && ['pending', 'delivered'].includes(item.deliveryStatus));
      updateNotificationCount(); renderNotifications();
      const unread = notificationRecords.filter(item => !item.viewedAt).length;
      status.textContent = `${notificationRecords.length} notification${notificationRecords.length === 1 ? '' : 's'} loaded · ${unread} unread${unread === 1 ? '' : 's'}.`;
    } catch (error) {
      status.textContent = error.message || 'Could not load notifications.';
      status.classList.add('notification-error');
      $('notifications-list').innerHTML = '<div class="notification-empty">Failed to load history. Check your session and try refreshing.</div>';
    } finally { notificationsLoading = false; $('refresh-notifications').disabled = false; }
  }
  $('refresh-notifications').addEventListener('click', () => { void loadNotifications(); });
  $('notification-filter').addEventListener('change', renderNotifications);
  $('notifications-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-notification-view]');
    if (!button || !notificationsApi) return;
    const id = button.dataset.notificationView;
    button.disabled = true;
    try {
      await notificationsApi.markViewed(id);
      const item = notificationRecords.find(record => record.id === id);
      if (item) item.viewedAt = new Date().toISOString();
      updateNotificationCount(); renderNotifications();
      const unread = notificationRecords.filter(record => !record.viewedAt).length;
      $('notifications-status').textContent = `${notificationRecords.length} notification${notificationRecords.length === 1 ? '' : 's'} loaded · ${unread} unread${unread === 1 ? '' : 's'}.`;
    } catch (error) { toast(error.message || 'Could not mark the notification.'); button.disabled = false; }
  });
  $('notification-nav-count').classList.add('hidden');
  void loadNotifications();
  function readInactivitySettingsForm() {
    return Object.fromEntries(Object.entries(inactivitySettingFields).map(([key,id]) => [key, Number($(id).value)]));
  }
  function writeInactivitySettingsForm(settings) {
    for (const [key,id] of Object.entries(inactivitySettingFields)) $(id).value = String(settings[key]);
  }
  function renderInactivitySettingsPreview() {
    const result = window.ZionInactivitySettings.preview(readInactivitySettingsForm());
    const preview = $('inactivity-preview-text');
    const feedback = $('inactivity-settings-feedback');
    feedback.classList.remove('error');
    if (!result.ok) {
      preview.textContent = 'Revise os prazos para visualizar o resumo.';
      feedback.textContent = result.error;
      feedback.classList.add('error');
      return false;
    }
    preview.textContent = `Warning on day ${result.pauseWarningAtDays}; pause on day ${result.pauseAfterDays}; reduction warning on day ${result.reductionWarningAtDays}; reduction on day ${result.reduceAfterDays}. The offer would decrease by ${result.reductionPercent}%, preserving ${result.remainingCapacityPercent}% of the previous capacity.`;
    return true;
  }
  function setInactivityFeedback(message, isError = false) {
    const feedback = $('inactivity-settings-feedback');
    feedback.textContent = message;
    feedback.classList.toggle('error', isError);
  }
  async function initializeInactivitySettings() {
    const mode = $('inactivity-settings-mode');
    if (inactivityApi) {
      mode.textContent = 'API autenticada';
      setInactivityFeedback('Loading account settings…');
      try {
        const response = await inactivityApi.get();
        writeInactivitySettingsForm(response.settings);
        renderInactivitySettingsPreview();
        setInactivityFeedback(response.appliedToNode ? 'Settings loaded; application confirmed by the service.' : 'Account settings loaded. The service reports they have not yet been applied to the node.');
      } catch (error) {
        setInactivityFeedback(error.message || 'Could not load authenticated settings.', true);
      }
      return;
    }
    const loaded = window.ZionInactivitySettings.load(inactivityStorage);
    writeInactivitySettingsForm(loaded);
    renderInactivitySettingsPreview();
    if (loaded.persistence === 'saved-local') setInactivityFeedback('Local preferences restored; no API session is connected.');
    else if (loaded.persistence === 'storage-unavailable') setInactivityFeedback('Browser storage unavailable; using defaults.');
    else if (loaded.persistence === 'invalid-reset') setInactivityFeedback('Invalid local setting; defaults loaded.');
    mode.textContent = 'Local preview';
  }
  Object.values(inactivitySettingFields).forEach(id => $(id).addEventListener('input', renderInactivitySettingsPreview));
  $('save-inactivity-settings').addEventListener('click', async () => {
    if (!renderInactivitySettingsPreview()) return;
    const settings = readInactivitySettingsForm();
    const button = $('save-inactivity-settings'); button.disabled = true;
    try {
      if (inactivityApi) {
        const response = await inactivityApi.put(settings);
        writeInactivitySettingsForm(response.settings);
        renderInactivitySettingsPreview();
        setInactivityFeedback(response.appliedToNode ? 'Settings saved and application confirmed by the service.' : 'Settings saved to the account; not yet applied to the node.');
      } else {
        const result = window.ZionInactivitySettings.save(inactivityStorage, settings);
        if (!result.ok) throw new Error(result.error);
        setInactivityFeedback('Schedule saved in this browser; not yet applied to the node.');
        toast('Inactivity preferences saved locally.');
      }
    } catch (error) { setInactivityFeedback(error.message || 'Failed to save settings.', true); }
    finally { button.disabled = false; }
  });
  $('reset-inactivity-settings').addEventListener('click', async () => {
    const button = $('reset-inactivity-settings'); button.disabled = true;
    try {
      if (inactivityApi) {
        const response = await inactivityApi.reset();
        writeInactivitySettingsForm(response.settings);
        renderInactivitySettingsPreview();
        setInactivityFeedback(response.appliedToNode ? 'Defaults restored; application confirmed by the service.' : 'Account defaults restored; not applied to the node.');
      } else {
        try { inactivityStorage?.removeItem(window.ZionInactivitySettings.KEY); } catch {}
        writeInactivitySettingsForm(window.ZionInactivitySettings.defaults);
        renderInactivitySettingsPreview();
        setInactivityFeedback('Defaults restored in this local preview.');
        toast('Default schedule restored.');
      }
    } catch (error) { setInactivityFeedback(error.message || 'Failed to restore settings.', true); }
    finally { button.disabled = false; }
  });
  void initializeInactivitySettings();
  $('clear-activity').addEventListener('click',()=>{activity=[];renderActivity('all-activity',activity);renderActivity();toast('Activity removed from this view.');});
  $('help-dialog').addEventListener('click',e=>{if(e.target===$('help-dialog'))$('help-dialog').close();});
  renderRecentFiles();renderFiles();renderActivity();renderActivity('all-activity',activity);
})();
