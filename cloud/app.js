'use strict';
(() => {
  const demoFiles = [
    {name:'Projeto Zion.pdf',type:'documento',size:2480000,modified:'Hoje, 09:42',icon:'PDF'},
    {name:'Fotos de viagem.zip',type:'imagem',size:186000000,modified:'Ontem, 18:20',icon:'▧'},
    {name:'Notas de reunião.docx',type:'documento',size:420000,modified:'Ontem, 14:08',icon:'W'},
    {name:'Apresentação.pptx',type:'documento',size:5200000,modified:'08 out. 2026',icon:'P'},
    {name:'Vídeo de demonstração.mp4',type:'video',size:84000000,modified:'07 out. 2026',icon:'▶'},
    {name:'Orçamento.xlsx',type:'documento',size:930000,modified:'06 out. 2026',icon:'X'},
    {name:'Logo Zion.svg',type:'imagem',size:78000,modified:'05 out. 2026',icon:'◇'},
    {name:'Arquivo compactado.tar',type:'outro',size:12300000,modified:'03 out. 2026',icon:'▤'}
  ];
  const demoActivity = [
    {icon:'↥',title:'Arquivo adicionado',detail:'Projeto Zion.pdf foi adicionado à prévia.',time:'Hoje, 09:42'},
    {icon:'◉',title:'Estado da rede consultado',detail:'Resumo ilustrativo de 3 nós.',time:'Hoje, 09:30'},
    {icon:'▤',title:'Arquivo aberto',detail:'Notas de reunião.docx foi aberto na prévia.',time:'Ontem, 14:08'},
    {icon:'✓',title:'Verificação de exemplo',detail:'Nenhum alerta fictício registrado nesta demonstração.',time:'08 out. 2026'}
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
    $('recent-files').innerHTML = files.slice(0,4).map(f=>`<div class="file-row"><span class="file-type-icon ${fileClass(f)}">${safe(iconFor(f))}</span><div class="file-info"><strong>${safe(f.name)}</strong><small>${safe(f.modified)}</small></div><span class="file-size">${fmtSize(f.size)}</span></div>`).join('') || '<p class="subheading">Nenhum arquivo por enquanto.</p>';
    $('file-count').textContent = String(128 + Math.max(0, files.length - demoFiles.length));
  }
  function renderFiles(){
    const q = $('file-search').value.trim().toLocaleLowerCase('pt-BR');
    const type = $('file-filter').value;
    const filtered = files.filter(f => f.name.toLocaleLowerCase('pt-BR').includes(q) && (type === 'todos' || f.type === type));
    $('all-files').innerHTML = filtered.map((f,i)=>`<tr><td><div class="table-file-name"><span class="file-type-icon ${fileClass(f)}">${safe(iconFor(f))}</span>${safe(f.name)}</div></td><td>${safe(({documento:'Documento',imagem:'Imagem',video:'Vídeo',outro:'Outro'})[f.type] || 'Arquivo')}</td><td>${fmtSize(f.size)}</td><td>${safe(f.modified)}</td><td><button class="row-actions" data-file-index="${files.indexOf(f)}" aria-label="Detalhes de ${safe(f.name)}" title="Detalhes">···</button></td></tr>`).join('');
    $('empty-files').classList.toggle('hidden', filtered.length > 0);
    $('all-files').parentElement.classList.toggle('hidden', filtered.length === 0);
    $('all-files').closest('.file-table-wrap').classList.toggle('compact', gridView);
  }
  function renderActivity(target='recent-activity', items=activity.slice(0,3)){
    $(target).innerHTML = items.map(a=>`<div class="activity-row"><span class="activity-icon">${safe(a.icon)}</span><div class="activity-copy"><strong>${safe(a.title)}</strong><p>${safe(a.detail)}</p></div><span class="activity-time">${safe(a.time)}</span></div>`).join('') || '<p class="subheading">Nenhuma atividade nesta visualização.</p>';
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
    const now = 'Agora';
    incoming.forEach(f=>{
      const ext=(f.name.split('.').pop()||'').toLowerCase();
      const type=['png','jpg','jpeg','gif','webp','svg','heic'].includes(ext)?'imagem':['mp4','mov','webm','mkv'].includes(ext)?'video':['pdf','doc','docx','txt','md','ppt','pptx','xls','xlsx','odt','rtf'].includes(ext)?'documento':'outro';
      files.unshift({name:f.name,type,size:f.size,modified:now,icon:({pdf:'PDF',doc:'W',docx:'W',pptx:'P',xlsx:'X'})[ext] || (type==='imagem'?'▧':type==='video'?'▶':type==='outro'?'▤':'DOC')});
    });
    activity.unshift({icon:'↥',title:`${incoming.length} arquivo${incoming.length===1?'':'s'} selecionado${incoming.length===1?'':'s'}`,detail:'Adicionado(s) à visualização local; não enviado(s) para a nuvem.',time:now});
    renderRecentFiles();renderFiles();renderActivity();renderActivity('all-activity',activity);
    toast(`${incoming.length} arquivo${incoming.length===1?'':'s'} adicionado${incoming.length===1?'':'s'} à prévia local.`);
  }
  const people = [
    {id:'ana',name:'Ana Costa',handle:'@anacosta',bio:'Design e arquivos abertos',avatar:'A',tone:'teal',following:true},
    {id:'marcos',name:'Marcos Lima',handle:'@marcoslima',bio:'Desenvolvimento distribuído',avatar:'M',tone:'',following:false},
    {id:'bia',name:'Beatriz Souza',handle:'@biasouza',bio:'Fotografia e comunidade',avatar:'B',tone:'rose',following:false},
    {id:'rafa',name:'Rafael Alves',handle:'@rafaalves',bio:'Privacidade digital',avatar:'R',tone:'gold',following:true}
  ];
  const conversations = new Map();
  let activeConversation = null;
  const nowLabel = () => new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  function renderPeople(){
    const query = $('people-search').value.trim().toLocaleLowerCase('pt-BR');
    const shown = people.filter(p => `${p.name} ${p.handle} ${p.bio}`.toLocaleLowerCase('pt-BR').includes(query));
    $('people-list').innerHTML = shown.map(p=>`<div class="person-row"><span class="person-avatar ${p.tone}">${safe(p.avatar)}</span><div class="person-meta"><strong>${safe(p.name)}</strong><small>${safe(p.handle)} · ${safe(p.bio)}</small></div><div class="person-actions"><button class="small-action ${p.following?'following':''}" data-follow="${safe(p.id)}" aria-pressed="${p.following}">${p.following?'Seguindo':'＋ Seguir'}</button><button class="small-action" data-message="${safe(p.id)}">Mensagem</button></div></div>`).join('') || '<div class="social-empty">Nenhuma pessoa encontrada. Tente outro nome.</div>';
  }
  function renderConversations(){
    const list = people.filter(p=>conversations.has(p.id)).sort((a,b)=>{
      const am=conversations.get(a.id), bm=conversations.get(b.id);
      return (bm.at(-1)?.order||0)-(am.at(-1)?.order||0);
    });
    $('conversation-list').innerHTML = list.map(p=>{
      const msgs=conversations.get(p.id)||[], last=msgs.at(-1);
      return `<button class="conversation-row ${activeConversation===p.id?'selected':''}" data-open-chat="${safe(p.id)}"><span class="person-avatar ${p.tone}">${safe(p.avatar)}</span><span class="person-meta"><strong>${safe(p.name)}</strong><small class="conversation-preview">${safe(last?.text||'Conversa iniciada')}</small></span><small>${safe(last?.time||'')}</small></button>`;
    }).join('') || '<div class="social-empty">Você ainda não tem conversas. Use “Mensagem” em um perfil para iniciar uma.</div>';
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
    $('chat-messages').innerHTML=msgs.map(m=>`<div class="chat-bubble ${m.mine?'mine':''}">${safe(m.text)}<time>${safe(m.time)}${m.mine?' · enviado nesta prévia':''}</time></div>`).join('') || '<div class="social-empty">Conversa iniciada. Escreva sua primeira mensagem abaixo.</div>';
    renderConversations();
    $('message-input').focus();
  }
  $('people-search').addEventListener('input',renderPeople);
  $('people-list').addEventListener('click',e=>{
    const follow=e.target.closest('[data-follow]');
    const message=e.target.closest('[data-message]');
    if(follow){const p=people.find(x=>x.id===follow.dataset.follow);if(!p)return;p.following=!p.following;renderPeople();toast(p.following?`Agora você segue ${p.name} nesta prévia.`:`Você deixou de seguir ${p.name} nesta prévia.`);return;}
    if(message){openConversation(message.dataset.message);}
  });
  $('conversation-list').addEventListener('click',e=>{const b=e.target.closest('[data-open-chat]');if(b)openConversation(b.dataset.openChat);});
  $('message-form').addEventListener('submit',e=>{
    e.preventDefault(); const input=$('message-input'); const value=input.value.trim();
    if(!value||!activeConversation)return;
    const messages=conversations.get(activeConversation)||[];
    messages.push({text:value,mine:true,time:nowLabel(),order:Date.now()}); conversations.set(activeConversation,messages);
    const person=people.find(p=>p.id===activeConversation);
    activity.unshift({icon:'✉',title:'Mensagem preparada',detail:`Mensagem para ${person?.name||'contato'} registrada somente nesta prévia local.`,time:'Agora'});
    input.value=''; openConversation(activeConversation); renderActivity();renderActivity('all-activity',activity);
    toast('Mensagem registrada nesta prévia; não foi enviada pela rede.');
  });
  renderPeople();renderConversations();

  document.querySelectorAll('.nav-item[data-page]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page)));
  document.querySelectorAll('[data-goto]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.goto)));
  $('upload-top').addEventListener('click',()=>$('file-picker').click());
  $('upload-files').addEventListener('click',()=>$('file-picker').click());
  $('file-picker').addEventListener('change',e=>{addFiles(e.target.files);e.target.value='';});
  $('file-search').addEventListener('input',renderFiles);$('file-filter').addEventListener('change',renderFiles);
  $('view-toggle').addEventListener('click',()=>{gridView=!gridView;$('view-toggle').textContent=gridView?'☷':'▦';toast(gridView?'Lista compacta ativada.':'Lista confortável ativada.');renderFiles();});
  $('all-files').addEventListener('click',e=>{const b=e.target.closest('[data-file-index]');if(!b)return;const f=files[Number(b.dataset.fileIndex)];if(f)toast(`${f.name} · ${fmtSize(f.size)} · demonstração local`);});
  $('mobile-menu').addEventListener('click',()=>$('sidebar').classList.toggle('open'));
  document.querySelector('.notice-close').addEventListener('click',e=>e.currentTarget.closest('.notice').remove());
  $('help-button').addEventListener('click',()=>$('help-dialog').showModal());$('close-help').addEventListener('click',()=>$('help-dialog').close());$('help-ok').addEventListener('click',()=>$('help-dialog').close());
  $('contribute-toggle').addEventListener('change',e=>{$('contribute-message').textContent=e.target.checked?'Preferência ativada apenas na demonstração. Nenhum serviço real foi iniciado.':'Preferência desativada. Nenhum serviço real foi iniciado.';toast(e.target.checked?'Contribuição simulada ativada.':'Contribuição simulada pausada.');});
  $('workspace-name').addEventListener('input',e=>document.querySelector('.profile strong').textContent=e.target.value.trim()||'Meu Zion');
  $('save-settings').addEventListener('click',()=>{$('settings-feedback').textContent='Preferência aplicada nesta sessão.';toast('Preferência atualizada nesta prévia.');});
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
    'pause-warning': { title: 'Aviso de pausa por inatividade', icon: '◷', style: 'warning' },
    'contribution-paused': { title: 'Contribuição pausada', icon: 'Ⅱ', style: 'paused' },
    'capacity-reduction-warning': { title: 'Aviso de redução de capacidade', icon: '↓', style: 'warning' },
    'capacity-reduction-pending': { title: 'Redução de capacidade pendente', icon: '⌛', style: 'warning' },
    'capacity-reduced': { title: 'Capacidade oferecida reduzida', icon: '↓', style: '' },
  };
  const notificationDate = value => {
    if (typeof value !== 'string') return 'Data indisponível';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Data indisponível' : date.toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
  };
  function updateNotificationCount() {
    const count = notificationRecords.filter(item => !item.viewedAt).length;
    const badge = $('notification-nav-count');
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count === 0);
    badge.setAttribute('aria-label', `${count} notificação${count === 1 ? '' : 'ões'} não visualizada${count === 1 ? '' : 's'}`);
  }
  function renderNotifications() {
    const list = $('notifications-list');
    const filter = $('notification-filter').value;
    const records = notificationRecords.filter(item => filter === 'all' || item.deliveryStatus === filter);
    if (!records.length) {
      list.innerHTML = `<div class="notification-empty">${notificationsApi ? 'Nenhuma notificação nesta categoria.' : 'Conecte uma sessão autenticada para consultar suas notificações reais.'}</div>`;
      return;
    }
    list.innerHTML = records.map(item => {
      const type = notificationTypes[item.type] || { title: 'Aviso do Zion', icon: '•', style: '' };
      const delivery = item.deliveryStatus === 'delivered' ? 'Entregue' : 'Entrega pendente';
      const unread = !item.viewedAt;
      return `<article class="notification-card"><span class="notification-symbol ${type.style}">${type.icon}</span><div class="notification-main"><strong>${safe(type.title)}</strong><p>${safe(item.message || 'O Zion registrou um evento de inatividade.')}</p><div class="notification-meta"><span>${safe(notificationDate(item.createdAt))}</span><span class="notification-state ${item.deliveryStatus === 'delivered' ? 'delivered' : ''}">${delivery}</span><span class="notification-state ${unread ? 'unread' : ''}">${unread ? 'Não visualizada' : 'Visualizada'}</span></div>${unread ? `<div class="notification-actions"><button type="button" data-notification-view="${safe(item.id)}">Marcar como visualizada</button></div>` : ''}</div></article>`;
    }).join('');
  }
  async function loadNotifications() {
    const status = $('notifications-status');
    if (notificationsLoading) return;
    if (!notificationsApi) {
      status.textContent = 'Sessão autenticada não configurada. O histórico real está indisponível.';
      $('notifications-list').innerHTML = '<div class="notification-empty">Esta prévia não cria avisos fictícios. Configure ZionAuth e a API de notificações para carregar o histórico.</div>';
      return;
    }
    notificationsLoading = true;
    $('refresh-notifications').disabled = true;
    status.classList.remove('notification-error');
    status.textContent = 'Carregando notificações da conta…';
    try {
      const response = await notificationsApi.list({ status: 'all', limit: 200 });
      if (!response || response.ok !== true || !Array.isArray(response.notifications)) throw new Error('Resposta incompleta do serviço de notificações.');
      notificationRecords = response.notifications.filter(item => item && typeof item.id === 'string' && typeof item.type === 'string' && typeof item.message === 'string' && ['pending', 'delivered'].includes(item.deliveryStatus));
      updateNotificationCount(); renderNotifications();
      const unread = notificationRecords.filter(item => !item.viewedAt).length;
      status.textContent = `${notificationRecords.length} notificação${notificationRecords.length === 1 ? '' : 'ões'} carregada${notificationRecords.length === 1 ? '' : 's'} · ${unread} não visualizada${unread === 1 ? '' : 's'}.`;
    } catch (error) {
      status.textContent = error.message || 'Não foi possível carregar as notificações.';
      status.classList.add('notification-error');
      $('notifications-list').innerHTML = '<div class="notification-empty">Falha ao consultar o histórico. Verifique a sessão e tente atualizar.</div>';
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
      $('notifications-status').textContent = `${notificationRecords.length} notificação${notificationRecords.length === 1 ? '' : 'ões'} carregada${notificationRecords.length === 1 ? '' : 's'} · ${unread} não visualizada${unread === 1 ? '' : 's'}.`;
    } catch (error) { toast(error.message || 'Não foi possível marcar a notificação.'); button.disabled = false; }
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
    preview.textContent = `Aviso no dia ${result.pauseWarningAtDays}; pausa no dia ${result.pauseAfterDays}; aviso de redução no dia ${result.reductionWarningAtDays}; redução no dia ${result.reduceAfterDays}. A oferta cairia ${result.reductionPercent}%, preservando ${result.remainingCapacityPercent}% da capacidade anterior.`;
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
      setInactivityFeedback('Carregando configurações da conta…');
      try {
        const response = await inactivityApi.get();
        writeInactivitySettingsForm(response.settings);
        renderInactivitySettingsPreview();
        setInactivityFeedback(response.appliedToNode ? 'Configurações carregadas; aplicação confirmada pelo serviço.' : 'Configurações da conta carregadas. O serviço informa que ainda não foram aplicadas ao nó.');
      } catch (error) {
        setInactivityFeedback(error.message || 'Não foi possível carregar as configurações autenticadas.', true);
      }
      return;
    }
    const loaded = window.ZionInactivitySettings.load(inactivityStorage);
    writeInactivitySettingsForm(loaded);
    renderInactivitySettingsPreview();
    if (loaded.persistence === 'saved-local') setInactivityFeedback('Preferências locais restauradas; não há sessão de API conectada.');
    else if (loaded.persistence === 'storage-unavailable') setInactivityFeedback('Armazenamento do navegador indisponível; usando os padrões.');
    else if (loaded.persistence === 'invalid-reset') setInactivityFeedback('Configuração local inválida; padrões carregados.');
    mode.textContent = 'Prévia local';
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
        setInactivityFeedback(response.appliedToNode ? 'Configurações salvas e aplicação confirmada pelo serviço.' : 'Configurações salvas na conta; ainda não aplicadas ao nó.');
      } else {
        const result = window.ZionInactivitySettings.save(inactivityStorage, settings);
        if (!result.ok) throw new Error(result.error);
        setInactivityFeedback('Prazos salvos neste navegador; ainda não aplicados ao nó.');
        toast('Preferências de inatividade salvas localmente.');
      }
    } catch (error) { setInactivityFeedback(error.message || 'Falha ao salvar as configurações.', true); }
    finally { button.disabled = false; }
  });
  $('reset-inactivity-settings').addEventListener('click', async () => {
    const button = $('reset-inactivity-settings'); button.disabled = true;
    try {
      if (inactivityApi) {
        const response = await inactivityApi.reset();
        writeInactivitySettingsForm(response.settings);
        renderInactivitySettingsPreview();
        setInactivityFeedback(response.appliedToNode ? 'Padrões restaurados; aplicação confirmada pelo serviço.' : 'Padrões da conta restaurados; não aplicados ao nó.');
      } else {
        try { inactivityStorage?.removeItem(window.ZionInactivitySettings.KEY); } catch {}
        writeInactivitySettingsForm(window.ZionInactivitySettings.defaults);
        renderInactivitySettingsPreview();
        setInactivityFeedback('Padrões restaurados nesta prévia local.');
        toast('Prazos padrão restaurados.');
      }
    } catch (error) { setInactivityFeedback(error.message || 'Falha ao restaurar as configurações.', true); }
    finally { button.disabled = false; }
  });
  void initializeInactivitySettings();
  $('clear-activity').addEventListener('click',()=>{activity=[];renderActivity('all-activity',activity);renderActivity();toast('Atividade removida desta visualização.');});
  $('help-dialog').addEventListener('click',e=>{if(e.target===$('help-dialog'))$('help-dialog').close();});
  renderRecentFiles();renderFiles();renderActivity();renderActivity('all-activity',activity);
})();
