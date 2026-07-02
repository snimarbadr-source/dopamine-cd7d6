// ═══════════════════════════════════════════════════════
//  Dopamine app.js v7 — Complete rewrite
// ═══════════════════════════════════════════════════════
import {
  collection, doc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, serverTimestamp, getDocs,
  setDoc, getDoc, addDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ── hideSplash must be defined before the await ──────────
function hideSplash() {
  const s = document.getElementById('splash');
  if (!s || s.classList.contains('fade-out')) return;
  s.classList.add('fade-out');
  setTimeout(() => s.style.display = 'none', 650);
}

// ── Wait for Firebase globals (max 3s) ───────────────────
await new Promise(r => {
  const t = setInterval(() => {
    if (window.__firebase_db && window.__firebase_auth) { clearInterval(t); r(); }
  }, 40);
  setTimeout(() => { hideSplash(); r(); }, 3000);
});

const db   = window.__firebase_db;
const auth = window.__firebase_auth;
const {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, sendPasswordResetEmail
} = window.__firebase_auth_fns;

// ── Admin secret ─────────────────────────────────────────
const ADMIN_NAME = '122#';
const ADMIN_ID   = '122#';

// ── Global state ─────────────────────────────────────────
let currentUser        = null;
let allTasks           = [];
let allUsers           = [];
let allLogs            = [];
let unsubTasks         = null;
let unsubUsers         = null;
let unsubLogs          = null;
let appLaunched        = false;
// wizard
let timerInterval      = null;
let taskStartTime      = null;
let pausedAt           = null;
let totalPausedMs      = 0;
let isPaused           = false;
let currentTaskId      = null;
let currentFsId        = null; // Firestore doc id
let beforeImgBlob      = null;
let afterImgBlob       = null;
let beforeImgUrl       = null;
let afterImgUrl        = null;
let beforeHash         = null;
let afterHash          = null;
// pagination
let myTasksPage    = 1;
let adminTasksPage = 1;
let empPage        = 1;
let monitorPage    = 1;
const PAGE_SIZE    = 50;
// notifications panel store
let notifStore = []; // [{type,title,msg,time,taskId?,beforeUrl?,afterUrl?}]
// wizard exposed hooks
let wizardGoStep            = null;
let wizardStartTimerExt     = () => {};

// ── Utility ──────────────────────────────────────────────
const genId = () =>
  `TASK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2,4).toUpperCase()}`;

function fmtTime(s) {
  if (!s || s < 0) s = 0;
  return [Math.floor(s/3600), Math.floor((s%3600)/60), s%60]
    .map(v => String(v).padStart(2,'0')).join(':');
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('ar-SA', { dateStyle:'short', timeStyle:'short' });
}
function fmtDateFull(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('ar-SA', { weekday:'short', year:'numeric', month:'short', day:'numeric' })
    + ' — ' + d.toLocaleTimeString('ar-SA', { hour:'2-digit', minute:'2-digit' });
}
const initials = n => (n||'?').split(' ').map(w=>w[0]).join('').substr(0,2).toUpperCase();
const statusLabel = s => ({
  pending:'قيد المراجعة', approved:'معتمدة', rejected:'مرفوضة',
  inprogress:'قيد التنفيذ', paused:'موقوف', assigned:'مُسندة'
})[s] || s;
const statusClass = s => `status-badge status-${s}`;
const statusIcon  = s => ({
  pending:'fa-clock', approved:'fa-circle-check', rejected:'fa-circle-xmark',
  inprogress:'fa-spinner fa-spin', paused:'fa-pause', assigned:'fa-paper-plane'
})[s] || 'fa-circle';

async function hashFile(file) {
  try {
    const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('');
  } catch { return String(Date.now()); }
}

function withTimeout(promise, ms = 12000, label = 'العملية') {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`انتهت مهلة ${label}`)), ms))
  ]);
}

// ── Image helpers — NO Storage, pure Base64 ───────────────
function resizeBlob(blob, maxPx = 800, q = 0.72) {
  return new Promise(res => {
    const img = new Image(), url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let {naturalWidth: w, naturalHeight: h} = img;
      const s = maxPx / Math.max(w, h);
      if (s < 1) { w = Math.round(w*s); h = Math.round(h*s); }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob(b => res(b || blob), 'image/jpeg', q);
    };
    img.onerror = () => res(blob);
    img.src = url;
  });
}
function blobToB64(blob) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.readAsDataURL(blob);
  });
}
async function processImage(blob, data) {
  // Watermark then compress to Base64
  const marked = await addWatermark(blob, data);
  const small  = await resizeBlob(marked, 700, 0.68);
  const b64    = await blobToB64(small);
  // If too large, compress harder
  if (b64.length > 900000) {
    const tiny = await resizeBlob(marked, 420, 0.55);
    return await blobToB64(tiny);
  }
  return b64;
}
async function addWatermark(file, data) {
  const r = await resizeBlob(file, 820, 0.76);
  return new Promise(res => {
    const img = new Image(), url = URL.createObjectURL(r);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const barH = Math.max(42, cv.height * 0.09);
      ctx.fillStyle = 'rgba(0,0,0,.82)';
      ctx.fillRect(0, cv.height - barH, cv.width, barH);
      const fs = Math.max(10, Math.min(cv.width * 0.022, 18));
      ctx.font = `bold ${fs}px Tajawal,sans-serif`;
      ctx.fillStyle = '#c9a84c'; ctx.textAlign = 'right'; ctx.direction = 'rtl';
      ctx.fillText(`${data.name} | ${data.nationalId} | ${data.type}`, cv.width - 8, cv.height - barH + fs + 3);
      ctx.fillStyle = '#f0e2c0'; ctx.font = `${Math.round(fs*.8)}px Tajawal,sans-serif`;
      ctx.fillText(`${data.taskId} | ${new Date().toLocaleString('ar-SA')}`, cv.width - 8, cv.height - 8);
      ctx.fillStyle = 'rgba(201,168,76,.55)'; ctx.fillRect(0, 0, cv.width*.28, fs*1.8);
      ctx.fillStyle = '#080600'; ctx.textAlign = 'left'; ctx.direction = 'ltr';
      ctx.font = `bold ${Math.round(fs*.73)}px sans-serif`;
      ctx.fillText('Dopamine™ VERIFIED', 5, fs);
      cv.toBlob(b => res(b || file), 'image/jpeg', .86);
    };
    img.onerror = () => res(file);
    img.src = url;
  });
}
async function calcSimilarity(b64A, b64B) {
  try {
    const loadI = src => new Promise((r,j) => {
      const i = new Image(); i.onload = ()=>r(i); i.onerror=j; i.src=src;
    });
    const [iA, iB] = await Promise.all([loadI(b64A), loadI(b64B)]);
    const s = 16, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const c = cv.getContext('2d');
    c.drawImage(iA,0,0,s,s); const dA = c.getImageData(0,0,s,s).data;
    c.clearRect(0,0,s,s); c.drawImage(iB,0,0,s,s); const dB = c.getImageData(0,0,s,s).data;
    let d=0;
    for (let i=0;i<dA.length;i+=4)
      d+=Math.abs(dA[i]-dB[i])+Math.abs(dA[i+1]-dB[i+1])+Math.abs(dA[i+2]-dB[i+2]);
    return Math.round((1-d/(s*s*3*255))*100);
  } catch { return null; }
}

// ── Lightbox ─────────────────────────────────────────────
window.openLightbox = function(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
};
document.getElementById('lightbox').onclick = function(e) {
  if (e.target === this || e.target.closest('.lightbox-close'))
    this.classList.add('hidden');
};

// ── Center Alert (replaces browser confirm/alert) ─────────
function showAlert({ type='info', title='', msg='', ok='حسناً', cancel=null, onOk, onCancel } = {}) {
  const el = document.getElementById('center-alert');
  const iconEl = document.getElementById('ca-icon');
  const icons = { info:'fa-circle-info', success:'fa-circle-check', error:'fa-circle-xmark', warning:'fa-triangle-exclamation' };
  iconEl.innerHTML = `<i class="fa-solid ${icons[type]||'fa-circle-info'}"></i>`;
  iconEl.className = `center-alert-icon${type==='warning'||type==='error' ? ' ca-warn' : type==='success' ? ' ca-success' : ''}`;
  document.getElementById('ca-title').textContent = title;
  document.getElementById('ca-msg').textContent   = msg;
  const okBtn     = document.getElementById('ca-ok');
  const cancelBtn = document.getElementById('ca-cancel');
  okBtn.textContent = ok;
  const clone = btn => { const c = btn.cloneNode(true); btn.replaceWith(c); return c; };
  const okC = clone(okBtn);
  document.getElementById('ca-ok'); // re-ref not needed, using okC
  if (cancel) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.textContent = cancel;
    const cancelC = clone(cancelBtn);
    cancelC.onclick = () => { el.classList.add('hidden'); onCancel?.(); };
  } else {
    cancelBtn.classList.add('hidden');
  }
  document.getElementById('ca-ok').onclick = () => { el.classList.add('hidden'); onOk?.(); };
  el.classList.remove('hidden');
}

// ── Toast ─────────────────────────────────────────────────
function toast(type, title, msg='', dur=4500) {
  const icons = { success:'fa-circle-check', error:'fa-circle-xmark', warning:'fa-triangle-exclamation', info:'fa-circle-info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fa-solid ${icons[type]||'fa-info'} toast-icon"></i><div><div class="toast-title">${title}</div>${msg?`<div class="toast-msg">${msg}</div>`:''}</div>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 320); }, dur);
}

// ── Notifications Panel ───────────────────────────────────
function pushNotif({ type='info', title='', msg='', taskId=null, beforeUrl=null, afterUrl=null, isTaskReview=false }) {
  notifStore.unshift({ type, title, msg, time: new Date(), taskId, beforeUrl, afterUrl, isTaskReview });
  if (notifStore.length > 30) notifStore.length = 30;
  renderNotifPanel();
  updateNotifBadge();
}

function renderNotifPanel() {
  const list = document.getElementById('notif-list');
  const last3 = notifStore.slice(0, 3);
  if (!last3.length) { list.innerHTML = '<div class="notif-empty">لا توجد تنبيهات</div>'; return; }
  const icons = { success:'fa-circle-check ni-success', error:'fa-circle-xmark ni-error', warning:'fa-triangle-exclamation ni-warning', info:'fa-circle-info ni-info' };
  list.innerHTML = last3.map((n, i) => {
    const [iconClass, niClass] = (icons[n.type]||'fa-circle-info ni-info').split(' ');
    const timeStr = n.time.toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'}) + ' — ' +
                    n.time.toLocaleDateString('ar-SA',{weekday:'short',day:'numeric',month:'short'});
    const imgPrev = (n.beforeUrl || n.afterUrl) ? `
      <div class="notif-item-preview">
        ${n.beforeUrl ? `<img src="${n.beforeUrl}" onclick="window.openLightbox(this.src)" title="قبل" />` : ''}
        ${n.afterUrl  ? `<img src="${n.afterUrl}"  onclick="window.openLightbox(this.src)" title="بعد"  />` : ''}
      </div>` : '';
    const actions = (n.isTaskReview && n.taskId && currentUser?.isAdmin) ? `
      <div class="notif-item-actions">
        <button class="notif-action-btn nab-approve" onclick="window.approveTask('${n.taskId}');document.getElementById('notif-panel').classList.add('hidden')">
          <i class="fa-solid fa-check"></i> اعتماد
        </button>
        <button class="notif-action-btn nab-reject" onclick="window.openTaskModal('${n.taskId}');document.getElementById('notif-panel').classList.add('hidden')">
          <i class="fa-solid fa-eye"></i> عرض
        </button>
      </div>` : '';
    return `
    <div class="notif-item" onclick="${n.taskId ? `window.openTaskModal('${n.taskId}')` : ''}">
      <div class="notif-item-top">
        <div class="notif-item-icon ${niClass}"><i class="fa-solid ${iconClass}"></i></div>
        <div class="notif-item-body">
          <div class="notif-item-title">${n.title}</div>
          ${n.msg ? `<div class="notif-item-msg">${n.msg}</div>` : ''}
          ${imgPrev}${actions}
          <div class="notif-item-time">${timeStr}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  const count = notifStore.length;
  if (count > 0) { badge.textContent = Math.min(count, 99); badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

// ── Log to Firestore ──────────────────────────────────────
async function logEvent(action, details = {}) {
  try {
    await addDoc(collection(db, 'logs'), {
      uid: currentUser?.uid || 'unknown', name: currentUser?.name || 'unknown',
      action, details, ts: serverTimestamp()
    });
  } catch { /* silent */ }
}

// ── Navigation ────────────────────────────────────────────
const PAGES = ['dashboard','new-task','my-tasks','admin','employees','monitor'];
const PAGE_TITLES = {
  dashboard:'الرئيسية','new-task':'مهمة جديدة','my-tasks':'مهامي',
  admin:'لوحة الإدارة', employees:'الموظفون', monitor:'متابعة النشاط'
};
function showPage(id) {
  PAGES.forEach(p => {
    const el = document.getElementById(`page-${p}`);
    if (el) { el.classList.toggle('active', p===id); el.classList.toggle('hidden', p!==id); }
  });
  document.querySelectorAll('.nav-item').forEach(el =>
    el.classList.toggle('active', el.dataset.page === id));
  document.getElementById('topbar-title').textContent = PAGE_TITLES[id] || '';
  if (id==='my-tasks')  { myTasksPage=1;    renderMyTasks(); }
  if (id==='admin')     { adminTasksPage=1; renderAdminPage(); }
  if (id==='employees') { empPage=1;        renderEmployees(); }
  if (id==='monitor')   { monitorPage=1;    renderMonitor(); }
  closeSidebar();
  document.getElementById('notif-panel').classList.add('hidden');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════
function initAuth() {
  setTimeout(hideSplash, 3000);
  onAuthStateChanged(auth, async fu => {
    hideSplash();
    if (fu) {
      document.getElementById('modal-auth').classList.add('hidden');
      if (appLaunched) return;
      try {
        const snap = await getDoc(doc(db,'users',fu.uid));
        if (snap.exists()) {
          currentUser = { uid: fu.uid, ...snap.data() };
          appLaunched = true;
          await logEvent('login', { email: fu.email });
          launchApp();
        } else {
          showCompleteProfile(fu);
        }
      } catch (e) { toast('error','خطأ',e.message); showAuthModal(); }
    } else {
      appLaunched = false;
      document.getElementById('app').classList.add('hidden');
      showAuthModal();
    }
  });
}

function showAuthModal() {
  const modal = document.getElementById('modal-auth');
  modal.classList.remove('hidden');
  let mode = 'login';

  const updateUI = () => {
    const isLogin = mode === 'login';
    document.getElementById('auth-title').textContent      = isLogin ? 'تسجيل الدخول' : 'إنشاء حساب';
    document.getElementById('auth-subtitle').textContent   = isLogin ? 'أهلاً بك في Dopamine' : 'سجّل حسابك الجديد';
    document.getElementById('auth-submit-btn').textContent = isLogin ? 'دخول' : 'إنشاء حساب';
    document.getElementById('auth-switch-text').innerHTML  = isLogin
      ? 'ليس لديك حساب؟ <span id="auth-switch-link">سجّل الآن</span>'
      : 'لديك حساب؟ <span id="auth-switch-link">تسجيل الدخول</span>';
    document.getElementById('auth-name-row').classList.toggle('hidden', isLogin);
    document.getElementById('auth-natid-row').classList.toggle('hidden', isLogin);
    document.getElementById('auth-pw-row').classList.remove('hidden');
    document.getElementById('forgot-pw-wrap').classList.toggle('hidden', !isLogin);
    document.getElementById('auth-error').textContent = '';
    document.getElementById('auth-success').classList.add('hidden');
    document.getElementById('auth-switch-link').onclick = () => { mode = isLogin?'register':'login'; updateUI(); };
  };
  updateUI();

  // Password toggle
  const togglePw = document.getElementById('toggle-pw');
  togglePw.onclick = function() {
    const inp = document.getElementById('auth-password');
    inp.type = inp.type==='password' ? 'text' : 'password';
    this.querySelector('i').classList.toggle('fa-eye');
    this.querySelector('i').classList.toggle('fa-eye-slash');
  };

  // Forgot password
  document.getElementById('btn-forgot-pw').onclick = async () => {
    const email = document.getElementById('auth-email').value.trim();
    if (!email) { document.getElementById('auth-error').textContent = 'أدخل بريدك الإلكتروني أولاً'; return; }
    try {
      await sendPasswordResetEmail(auth, email);
      document.getElementById('auth-success').textContent = `تم إرسال رابط إعادة التعيين إلى ${email} — تحقق من بريدك 📧`;
      document.getElementById('auth-success').classList.remove('hidden');
      document.getElementById('auth-error').textContent = '';
    } catch (e) {
      const msgs = {'auth/user-not-found':'لا يوجد حساب بهذا البريد','auth/invalid-email':'البريد غير صحيح'};
      document.getElementById('auth-error').textContent = msgs[e.code] || e.message;
    }
  };

  // Submit
  const btnEl = document.getElementById('auth-submit-btn');
  const fresh = btnEl.cloneNode(true); btnEl.replaceWith(fresh);
  document.getElementById('auth-submit-btn').onclick = async () => {
    const email = document.getElementById('auth-email').value.trim();
    const pw    = document.getElementById('auth-password').value;
    const name  = document.getElementById('auth-name').value.trim();
    const natId = document.getElementById('auth-natid').value.trim();
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';
    if (!email||!pw) { errEl.textContent='يرجى إدخال البريد وكلمة المرور'; return; }
    if (mode==='register'&&(!name||!natId)) { errEl.textContent='يرجى إدخال الاسم والرقم الوطني'; return; }
    const btn = document.getElementById('auth-submit-btn');
    btn.disabled=true; btn.textContent='...';
    try {
      if (mode==='login') {
        await signInWithEmailAndPassword(auth, email, pw);
        modal.classList.add('hidden');
      } else {
        const isAdmin = (name===ADMIN_NAME && natId===ADMIN_ID);
        const cred    = await createUserWithEmailAndPassword(auth, email, pw);
        const uData   = { name, nationalId:natId, isAdmin, role:isAdmin?'both':'employee', email, createdAt:serverTimestamp(), trustScore:100 };
        await setDoc(doc(db,'users',cred.user.uid), uData);
        modal.classList.add('hidden');
        currentUser = { uid:cred.user.uid, ...uData };
        if (isAdmin) toast('success','مرحباً مسؤولاً! 👑','صلاحيات الإدارة مفعّلة');
        await logEvent('register',{email,isAdmin});
        appLaunched = true; launchApp();
      }
    } catch (e) {
      const m={'auth/email-already-in-use':'البريد مستخدم مسبقاً','auth/invalid-email':'البريد غير صحيح',
        'auth/weak-password':'6 أحرف على الأقل','auth/user-not-found':'لا يوجد حساب بهذا البريد',
        'auth/wrong-password':'كلمة المرور غير صحيحة','auth/invalid-credential':'البريد أو كلمة المرور غير صحيحة',
        'auth/too-many-requests':'محاولات كثيرة، انتظر قليلاً'};
      errEl.textContent = m[e.code] || e.message;
      btn.disabled=false; btn.textContent=mode==='login'?'دخول':'إنشاء حساب';
    }
  };
  ['auth-email','auth-password','auth-name','auth-natid'].forEach(id =>
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key==='Enter') document.getElementById('auth-submit-btn').click();
    }));
}

function showCompleteProfile(fu) {
  document.getElementById('modal-complete-profile').classList.remove('hidden');
  document.getElementById('cp-email').textContent = fu.email;
  const btn = document.getElementById('btn-cp-submit');
  const c = btn.cloneNode(true); btn.replaceWith(c);
  document.getElementById('btn-cp-submit').onclick = async () => {
    const name  = document.getElementById('cp-name').value.trim();
    const natId = document.getElementById('cp-natid').value.trim();
    if (!name||!natId) { toast('error','تنبيه','يرجى إدخال الاسم والرقم الوطني'); return; }
    const isAdmin = (name===ADMIN_NAME && natId===ADMIN_ID);
    try {
      const uData = { name, nationalId:natId, isAdmin, role:isAdmin?'both':'employee', email:fu.email, createdAt:serverTimestamp(), trustScore:100 };
      await setDoc(doc(db,'users',fu.uid), uData);
      currentUser = { uid:fu.uid, ...uData };
      document.getElementById('modal-complete-profile').classList.add('hidden');
      if (isAdmin) toast('success','مرحباً مسؤولاً! 👑','');
      appLaunched=true; launchApp();
    } catch (e) { toast('error','خطأ',e.message); }
  };
}

async function doLogout() {
  showAlert({ type:'warning', title:'تسجيل الخروج', msg:'هل تريد تسجيل الخروج من Dopamine؟', ok:'خروج', cancel:'إلغاء',
    onOk: async () => {
      await logEvent('logout',{});
      [unsubTasks,unsubUsers,unsubLogs].forEach(u => { if(u){u();} });
      unsubTasks=unsubUsers=unsubLogs=null;
      clearInterval(timerInterval);
      allTasks=[]; allUsers=[]; allLogs=[]; currentUser=null; appLaunched=false;
      notifStore=[];
      document.getElementById('app').classList.add('hidden');
      await signOut(auth);
    }
  });
}

// ═══════════════════════════════════════════════════════
//  LAUNCH APP
// ═══════════════════════════════════════════════════════
function launchApp() {
  document.getElementById('app').classList.remove('hidden');
  ['modal-auth','modal-complete-profile'].forEach(id =>
    document.getElementById(id)?.classList.add('hidden'));

  document.getElementById('sidebar-name').textContent   = currentUser.name;
  document.getElementById('sidebar-role').textContent   = currentUser.isAdmin ? '👑 مسؤول' : '👤 موظف';
  document.getElementById('sidebar-avatar').textContent = initials(currentUser.name);
  document.getElementById('sidebar-email').textContent  = currentUser.email || '';
  document.getElementById('welcome-msg').textContent    = `مرحباً، ${currentUser.name.split(' ')[0]} 👋`;
  document.getElementById('today-date').textContent     =
    new Date().toLocaleDateString('ar-SA',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

  document.querySelectorAll('.admin-only').forEach(el =>
    el.classList.toggle('hidden', !currentUser.isAdmin));

  startListeners();

  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    const c = el.cloneNode(true); el.replaceWith(c);
    c.addEventListener('click', e => { e.preventDefault(); showPage(c.dataset.page); });
  });

  const rl = (id, fn) => {
    const el = document.getElementById(id); if (!el) return;
    const c = el.cloneNode(true); el.replaceWith(c); c.addEventListener('click', fn);
  };
  rl('menu-toggle', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('hidden');
  });
  rl('sidebar-overlay', closeSidebar);
  rl('btn-start-quick', () => showPage('new-task'));
  rl('modal-task-close',  () => document.getElementById('modal-task').classList.add('hidden'));
  rl('modal-emp-close',   () => document.getElementById('modal-employee').classList.add('hidden'));
  rl('modal-assign-close',() => document.getElementById('modal-assign').classList.add('hidden'));
  rl('btn-logout',        doLogout);
  rl('notif-bell', () => {
    const panel = document.getElementById('notif-panel');
    panel.classList.toggle('hidden');
    renderNotifPanel();
  });
  rl('notif-clear-all', () => {
    notifStore = [];
    renderNotifPanel();
    updateNotifBadge();
  });

  document.getElementById('my-filter-status').onchange = () => { myTasksPage=1; renderMyTasks(); };
  document.getElementById('my-search').oninput = () => { myTasksPage=1; renderMyTasks(); };
  document.getElementById('adm-search').oninput = () => { adminTasksPage=1; renderAdminPage(); };
  document.getElementById('adm-filter-status').onchange = () => { adminTasksPage=1; renderAdminPage(); };
  document.getElementById('adm-filter-type').onchange = () => { adminTasksPage=1; renderAdminPage(); };
  document.getElementById('emp-search').oninput = () => { empPage=1; renderEmployees(); };
  const monS = document.getElementById('mon-search');
  const monF = document.getElementById('mon-filter-action');
  if (monS) monS.oninput = () => { monitorPage=1; renderMonitor(); };
  if (monF) monF.onchange = () => { monitorPage=1; renderMonitor(); };

  document.getElementById('modal-task').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-task'))
      document.getElementById('modal-task').classList.add('hidden');
  });
  document.getElementById('modal-assign').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-assign'))
      document.getElementById('modal-assign').classList.add('hidden');
  });
  document.addEventListener('click', e => {
    const panel = document.getElementById('notif-panel');
    const bell  = document.getElementById('notif-bell');
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !bell.contains(e.target))
      panel.classList.add('hidden');
  });

  if (currentUser.isAdmin) {
    const ab = document.getElementById('btn-assign-task');
    if (ab) { ab.classList.remove('hidden'); rl('btn-assign-task', () => openAssignModal()); }
  }

  // Check for pending resume state
  checkPendingResume();
  initWizard();
}

// ═══════════════════════════════════════════════════════
//  FIRESTORE LISTENERS
// ═══════════════════════════════════════════════════════
function startListeners() {
  [unsubTasks,unsubUsers,unsubLogs].forEach(u => { if(u)u(); });

  const tq = currentUser.isAdmin
    ? query(collection(db,'tasks'), orderBy('createdAt','desc'))
    : query(collection(db,'tasks'), where('ownerUid','==',currentUser.uid), orderBy('createdAt','desc'));

  unsubTasks = onSnapshot(tq, snap => {
    allTasks = snap.docs.map(d => ({id:d.id,...d.data()}));
    updateDashStats(); checkNotifs();
    const act = document.querySelector('.page.active')?.id;
    if (act==='page-my-tasks')  renderMyTasks();
    if (act==='page-admin')     renderAdminPage();
    if (act==='page-employees') renderEmployees();
  }, err => toast('error','خطأ في الاتصال',err.message));

  if (currentUser.isAdmin) {
    unsubUsers = onSnapshot(collection(db,'users'), snap => {
      allUsers = snap.docs.map(d => ({uid:d.id,...d.data()}));
      if (document.querySelector('.page.active')?.id==='page-employees') renderEmployees();
    });
    const lq = query(collection(db,'logs'), orderBy('ts','desc'));
    unsubLogs = onSnapshot(lq, snap => {
      allLogs = snap.docs.map(d => ({id:d.id,...d.data()}));
      if (document.querySelector('.page.active')?.id==='page-monitor') renderMonitor();
    }, () => {});
  }
}

// ═══════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════
function updateDashStats() {
  const mine = currentUser.isAdmin ? allTasks
    : allTasks.filter(t => t.ownerUid===currentUser.uid);
  document.getElementById('stat-approved').textContent   = mine.filter(t=>t.status==='approved').length;
  document.getElementById('stat-pending').textContent    = mine.filter(t=>t.status==='pending').length;
  document.getElementById('stat-rejected').textContent   = mine.filter(t=>t.status==='rejected').length;
  document.getElementById('stat-inprogress').textContent = mine.filter(t=>['inprogress','paused'].includes(t.status)).length;
  const done = mine.filter(t=>t.status==='approved'||t.status==='rejected');
  const trust = done.length ? Math.round(done.filter(t=>t.status==='approved').length/done.length*100) : 100;
  document.getElementById('trust-value').textContent = trust+'%';
  const fill = document.getElementById('trust-bar-fill');
  fill.style.width = trust+'%';
  fill.style.background = trust>=70 ? 'linear-gradient(90deg,#1d5a38,#4caf7d)'
    : trust>=40 ? 'linear-gradient(90deg,#8a6210,#c9a84c)'
    : 'linear-gradient(90deg,#6b1a1a,#c0392b)';
  const mini = mine.slice(0,6);
  const el = document.getElementById('recent-tasks-list');
  if (!mini.length) { el.innerHTML='<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>لا توجد مهام بعد</p></div>'; return; }
  el.innerHTML = mini.map(t => `
    <div class="task-mini-card" onclick="window.openTaskModal('${t.id}')">
      <div class="task-mini-id">${t.taskId||t.id.substr(0,8)}</div>
      <div class="task-mini-info">
        <div class="task-mini-name">${t.type||'—'}</div>
        <div class="task-mini-sub">${fmtDate(t.createdAt)}</div>
      </div>
      <span class="${statusClass(t.status)}"><i class="fa-solid ${statusIcon(t.status)}"></i> ${statusLabel(t.status)}</span>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════
//  NOTIFICATIONS
// ═══════════════════════════════════════════════════════
const seenSet = new Set(JSON.parse(localStorage.getItem('dopamine_seen')||'[]'));

function checkNotifs() {
  allTasks.forEach(t => {
    const k = `${t.id}-${t.status}`;
    if (seenSet.has(k)) return;
    seenSet.add(k);
    // Personal notifications (any user who owns the task)
    if (t.ownerUid === currentUser.uid) {
      if (t.status==='approved') {
        toast('success','✅ تم اعتماد مهمتك!',`المهمة ${t.taskId}`);
        pushNotif({type:'success',title:'✅ تم اعتماد مهمتك!',msg:`المهمة ${t.taskId}`,taskId:t.id,beforeUrl:t.beforeUrl,afterUrl:t.afterUrl});
      }
      if (t.status==='rejected') {
        toast('error','❌ تم رفض مهمتك',t.rejectReason?`السبب: ${t.rejectReason}`:'');
        pushNotif({type:'error',title:'❌ تم رفض مهمتك',msg:t.rejectReason||'',taskId:t.id});
      }
      if (t.status==='assigned') {
        toast('warning','📋 مهمة جديدة أُسندت إليك!',`${t.type} — كمية: ${t.assignedQty||'—'}`,8000);
        pushNotif({type:'warning',title:'📋 مهمة جديدة!',msg:`${t.type} — كمية: ${t.assignedQty||'—'} | من: ${t.assignedBy||'المسؤول'}`,taskId:t.id});
      }
    }
    // Admin-only
    if (currentUser.isAdmin) {
      if (t.status==='pending') {
        toast('info','📋 مهمة للمراجعة',`${t.employeeName} — ${t.type}`);
        pushNotif({type:'info',title:'📋 مهمة للمراجعة',msg:`${t.employeeName} — ${t.type}`,taskId:t.id,beforeUrl:t.beforeUrl,afterUrl:t.afterUrl,isTaskReview:true});
      }
      if (t.status==='paused') {
        toast('warning','⏸ إيقاف مؤقت',`${t.employeeName} — ${t.pausedElapsed||'—'}`);
        pushNotif({type:'warning',title:'⏸ إيقاف مؤقت',msg:`${t.employeeName}`,taskId:t.id});
      }
    }
  });
  localStorage.setItem('dopamine_seen', JSON.stringify([...seenSet].slice(-400)));
}

// ═══════════════════════════════════════════════════════
//  PAGINATION BAR
// ═══════════════════════════════════════════════════════
function renderPaginationBar(cid, total, page, perPage, onGoto) {
  const el = document.getElementById(cid); if (!el) return;
  const totalPages = Math.max(1, Math.ceil(total/perPage));
  if (totalPages<=1) { el.innerHTML=''; return; }
  let startP = Math.max(1, page-2), endP = Math.min(totalPages, startP+4);
  startP = Math.max(1, endP-4);
  let html = `<button class="pg-btn" ${page<=1?'disabled':''} data-pg="${page-1}"><i class="fa-solid fa-chevron-right"></i></button>`;
  for (let p=startP;p<=endP;p++)
    html += `<button class="pg-btn${p===page?' active':''}" data-pg="${p}">${p}</button>`;
  html += `<button class="pg-btn" ${page>=totalPages?'disabled':''} data-pg="${page+1}"><i class="fa-solid fa-chevron-left"></i></button>`;
  html += `<span class="pg-info">${page}/${totalPages} · ${total} عنصر</span>`;
  el.innerHTML = html;
  el.querySelectorAll('.pg-btn[data-pg]').forEach(btn =>
    btn.onclick = () => onGoto(parseInt(btn.dataset.pg)));
}

// ═══════════════════════════════════════════════════════
//  MY TASKS
// ═══════════════════════════════════════════════════════
function renderMyTasks() {
  const f = document.getElementById('my-filter-status').value;
  const s = (document.getElementById('my-search').value||'').toLowerCase();
  let t = currentUser.isAdmin ? allTasks : allTasks.filter(x=>x.ownerUid===currentUser.uid);
  if (f) t = t.filter(x=>x.status===f);
  if (s) t = t.filter(x=>(x.taskId||'').toLowerCase().includes(s)||(x.type||'').toLowerCase().includes(s));
  const start = (myTasksPage-1)*PAGE_SIZE;
  renderTaskCards('my-tasks-list', t.slice(start, start+PAGE_SIZE), false);
  renderPaginationBar('my-tasks-pagination', t.length, myTasksPage, PAGE_SIZE, p=>{myTasksPage=p;renderMyTasks();});
}

// ═══════════════════════════════════════════════════════
//  ADMIN PAGE
// ═══════════════════════════════════════════════════════
function renderAdminPage() {
  const s   = (document.getElementById('adm-search').value||'').toLowerCase();
  const fSt = document.getElementById('adm-filter-status').value;
  const fTy = document.getElementById('adm-filter-type').value;
  let t = [...allTasks];
  if (s)   t = t.filter(x=>(x.employeeName||'').toLowerCase().includes(s)||(x.type||'').toLowerCase().includes(s)||(x.taskId||'').toLowerCase().includes(s)||(x.nationalId||'').includes(s));
  if (fSt) t = t.filter(x=>x.status===fSt);
  if (fTy) t = t.filter(x=>x.type===fTy);
  const start = (adminTasksPage-1)*PAGE_SIZE;
  renderTaskCards('admin-tasks-list', t.slice(start,start+PAGE_SIZE), true);
  renderPaginationBar('admin-tasks-pagination', t.length, adminTasksPage, PAGE_SIZE, p=>{adminTasksPage=p;renderAdminPage();});
  const today = new Date().toDateString();
  document.getElementById('adm-stat-pending').textContent  = allTasks.filter(x=>x.status==='pending').length;
  document.getElementById('adm-stat-approved').textContent = allTasks.filter(x=>x.status==='approved').length;
  document.getElementById('adm-stat-rejected').textContent = allTasks.filter(x=>x.status==='rejected').length;
  document.getElementById('adm-stat-today').textContent    = allTasks.filter(x=>{
    const d=x.createdAt?.toDate?x.createdAt.toDate():new Date(x.createdAt||0);
    return d.toDateString()===today;
  }).length;
  const done = allTasks.filter(x=>x.duration);
  document.getElementById('adm-avg-time').textContent = done.length ? fmtTime(Math.round(done.reduce((a,x)=>a+(x.duration||0),0)/done.length)) : '—';
  const em={},st={};
  allTasks.filter(x=>x.status==='approved').forEach(x=>{em[x.employeeName]=(em[x.employeeName]||0)+1;});
  allTasks.forEach(x=>{if(x.type)st[x.type]=(st[x.type]||0)+1;});
  const te=Object.entries(em).sort((a,b)=>b[1]-a[1])[0];
  const ts=Object.entries(st).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('adm-top-emp').textContent   = te?`${te[0]} (${te[1]})`:'—';
  document.getElementById('adm-top-store').textContent = ts?ts[0]:'—';
}

// ═══════════════════════════════════════════════════════
//  TASK CARDS
// ═══════════════════════════════════════════════════════
function renderTaskCards(cid, tasks, isAdmin) {
  const el = document.getElementById(cid);
  if (!tasks.length) { el.innerHTML='<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-inbox"></i><p>لا توجد مهام</p></div>'; return; }
  el.innerHTML = tasks.map(t => {
    const sim = t.similarity && t.similarity>=85;
    const isAssigned = t.status==='assigned';
    const isMyInProgress = !isAdmin && t.status==='inprogress' && t.ownerUid===currentUser.uid;
    return `
    <div class="task-card${isAssigned?' task-card-assigned':''}" onclick="window.openTaskModal('${t.id}')">
      <div class="task-card-header">
        <span class="task-card-id">${t.taskId||t.id.substr(0,8)}</span>
        <span class="${statusClass(t.status)}"><i class="fa-solid ${statusIcon(t.status)}"></i> ${statusLabel(t.status)}</span>
      </div>
      ${sim?`<div class="warning-similar"><i class="fa-solid fa-triangle-exclamation"></i> تحذير: الصورتان متشابهتان (${t.similarity}%)</div>`:''}
      ${t.pausedElapsed?`<div class="warning-similar"><i class="fa-solid fa-pause"></i> أُوقف مؤقتاً — ${t.pausedElapsed}</div>`:''}
      ${t.lastLeftAt?`<div class="warning-similar"><i class="fa-solid fa-door-open"></i> تُرك مؤقتاً — آخر مغادرة: ${fmtDate(t.lastLeftAt)}</div>`:''}
      ${isAssigned?`<div class="assigned-info"><i class="fa-solid fa-paper-plane"></i> من: ${t.assignedBy||'المسؤول'} | الكمية: <strong>${t.assignedQty||'—'}</strong></div>`:''}
      <div class="task-card-body">
        <div class="task-card-imgs">
          ${t.beforeUrl?`<img src="${t.beforeUrl}" onclick="event.stopPropagation();window.openLightbox(this.src)" alt="قبل"/>`:'<div class="task-card-img-placeholder"></div>'}
          ${t.afterUrl?`<img src="${t.afterUrl}"  onclick="event.stopPropagation();window.openLightbox(this.src)" alt="بعد"/>` :'<div class="task-card-img-placeholder"></div>'}
        </div>
        <div class="task-card-info">
          <div class="task-card-title">${t.type||'—'}</div>
          <div class="task-card-meta">
            <span><i class="fa-solid fa-user"></i>${t.employeeName||'—'}</span>
            <span><i class="fa-solid fa-clock"></i>${t.duration?fmtTime(t.duration):'—'}</span>
            <span><i class="fa-solid fa-calendar"></i>${fmtDate(t.createdAt)}</span>
            ${t.assignedQty?`<span><i class="fa-solid fa-hashtag"></i>${t.assignedQty}</span>`:''}
          </div>
        </div>
      </div>
      ${isAdmin&&t.status==='pending'?`
      <div class="task-card-footer" onclick="event.stopPropagation()">
        <div class="task-card-actions">
          <button class="btn-approve" onclick="window.approveTask('${t.id}')"><i class="fa-solid fa-check"></i> اعتماد</button>
          <button class="btn-amend"   onclick="window.amendTask('${t.id}')"><i class="fa-solid fa-pen"></i> تعديل</button>
          <button class="btn-reject"  onclick="window.rejectTask('${t.id}')"><i class="fa-solid fa-xmark"></i> رفض</button>
        </div>
      </div>`:
      isAdmin&&t.status==='approved'?`
      <div class="task-card-footer" onclick="event.stopPropagation()">
        <button class="btn-delete-task" onclick="window.deleteApprovedTask('${t.id}','${t.taskId||t.id}')">
          <i class="fa-solid fa-trash"></i> حذف المهمة
        </button>
      </div>`:
      !isAdmin&&isAssigned?`
      <div class="task-card-footer" onclick="event.stopPropagation()">
        <button class="btn-approve btn-full" onclick="window.startAssignedTask('${t.id}')">
          <i class="fa-solid fa-play"></i> ابدأ تنفيذ المهمة
        </button>
      </div>`:
      isMyInProgress?`
      <div class="task-card-footer" onclick="event.stopPropagation()">
        <button class="btn-approve btn-full" onclick="window.resumeLeftTask('${t.id}')">
          <i class="fa-solid fa-rotate-left"></i> إكمال المهمة
        </button>
      </div>`:''}
    </div>`;
  }).join('');
}

window.deleteApprovedTask = function(id, label) {
  if (!currentUser.isAdmin) return;
  showAlert({ type:'warning', title:'حذف المهمة', msg:`هل أنت متأكد من حذف المهمة ${label} نهائياً؟ لا يمكن التراجع.`,
    ok:'حذف', cancel:'إلغاء',
    onOk: async () => {
      try { await deleteDoc(doc(db,'tasks',id)); await logEvent('delete_task',{taskId:label}); document.getElementById('modal-task').classList.add('hidden'); toast('success','تم الحذف 🗑️',''); }
      catch (e) { toast('error','خطأ',e.message); }
    }
  });
};

// ═══════════════════════════════════════════════════════
//  EMPLOYEES
// ═══════════════════════════════════════════════════════
function renderEmployees() {
  const s = (document.getElementById('emp-search').value||'').toLowerCase();
  const map = {};
  allUsers.forEach(u => { map[u.uid]={name:u.name,id:u.nationalId,uid:u.uid,email:u.email,role:u.role||(u.isAdmin?'admin':'employee'),isAdmin:u.isAdmin,tasks:[]}; });
  allTasks.forEach(t => {
    if (!t.ownerUid) return;
    if (!map[t.ownerUid]) map[t.ownerUid]={name:t.employeeName,id:t.nationalId,uid:t.ownerUid,email:'',role:'employee',isAdmin:false,tasks:[]};
    map[t.ownerUid].tasks.push(t);
  });
  let emps = Object.values(map);
  if (s) emps = emps.filter(e=>(e.name||'').toLowerCase().includes(s)||(e.id||'').includes(s));
  const total = emps.length;
  const el = document.getElementById('employees-list');
  if (!total) { el.innerHTML='<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-users-slash"></i><p>لا يوجد موظفون</p></div>'; document.getElementById('emp-pagination').innerHTML=''; return; }
  const start = (empPage-1)*PAGE_SIZE;
  el.innerHTML = emps.slice(start,start+PAGE_SIZE).map(e => {
    const ap=e.tasks.filter(t=>t.status==='approved').length;
    const pe=e.tasks.filter(t=>t.status==='pending').length;
    const re=e.tasks.filter(t=>t.status==='rejected').length;
    const tr=e.tasks.length?Math.round(ap/e.tasks.length*100):100;
    const done=e.tasks.filter(t=>t.endTime).sort((a,b)=>{
      const da=a.endTime?.toDate?a.endTime.toDate():new Date(a.endTime||0);
      const db2=b.endTime?.toDate?b.endTime.toDate():new Date(b.endTime||0); return db2-da;});
    const last=done[0];
    const lastStr=last?`${last.type||'—'} — ${fmtDateFull(last.endTime)}`:'لا توجد مهام مكتملة بعد';
    const roleBadge=e.role==='both'?'<span class="role-badge role-both">👑👤 موظف ومسؤول</span>'
      :e.role==='admin'?'<span class="role-badge role-admin">👑 مسؤول</span>'
      :'<span class="role-badge role-emp">👤 موظف</span>';
    return `
    <div class="emp-card">
      <div class="emp-card-top" onclick="window.openEmpModal('${e.uid}')">
        <div class="emp-avatar">${initials(e.name)}</div>
        <div style="flex:1;min-width:0">
          <div class="emp-name">${e.name}</div>
          <div class="emp-id"><i class="fa-solid fa-id-card"></i> ${e.id||'—'}</div>
          <div class="emp-last" title="${lastStr}"><i class="fa-solid fa-clock-rotate-left"></i><span>${lastStr.length>44?lastStr.substr(0,44)+'...':lastStr}</span></div>
        </div>
        ${roleBadge}
      </div>
      <div class="emp-stats">
        <div class="emp-stat-item"><div class="emp-stat-num" style="color:var(--green)">${ap}</div><div class="emp-stat-lbl">معتمدة</div></div>
        <div class="emp-stat-item"><div class="emp-stat-num" style="color:var(--gold)">${pe}</div><div class="emp-stat-lbl">مراجعة</div></div>
        <div class="emp-stat-item"><div class="emp-stat-num" style="color:var(--red)">${re}</div><div class="emp-stat-lbl">مرفوضة</div></div>
      </div>
      <div style="margin-top:9px">
        <div class="emp-trust-label"><span>نسبة الثقة</span><span>${tr}%</span></div>
        <div class="emp-trust-bar"><div class="emp-trust-fill" style="width:${tr}%"></div></div>
      </div>
      ${currentUser.isAdmin?`
      <div class="emp-actions">
        <button class="btn-emp-action btn-assign-emp" onclick="window.openAssignModal('${e.uid}','${e.name}')"><i class="fa-solid fa-paper-plane"></i> إرسال مهمة</button>
        <button class="btn-emp-action btn-role-toggle" onclick="window.toggleRole('${e.uid}','${e.role}','${e.name}')"><i class="fa-solid fa-user-shield"></i> ${e.role==='both'?'إزالة إدارة':e.role==='admin'?'موظف فقط':'منح إدارة'}</button>
        <button class="btn-emp-action btn-delete-emp" onclick="window.deleteEmployee('${e.uid}','${e.name}')"><i class="fa-solid fa-trash"></i> حذف</button>
      </div>`:''}
    </div>`;
  }).join('');
  renderPaginationBar('emp-pagination', total, empPage, PAGE_SIZE, p=>{empPage=p;renderEmployees();});
}

window.toggleRole = async function(uid, role, name) {
  const newRole = role==='both' ? 'employee' : 'both';
  const newAdmin = newRole==='both';
  const msg = newAdmin ? `سيحصل ${name} على صلاحية الإدارة مع احتفاظه بدور الموظف` : `ستُزال صلاحية الإدارة من ${name}`;
  showAlert({ type:'warning', title:'تغيير الصلاحية', msg, ok:'تأكيد', cancel:'إلغاء',
    onOk: async () => {
      try { await updateDoc(doc(db,'users',uid),{isAdmin:newAdmin,role:newRole}); await logEvent('role_change',{targetUid:uid,name,newRole}); toast('success','تم',''); }
      catch (e) { toast('error','خطأ',e.message); }
    }
  });
};
window.deleteEmployee = function(uid, name) {
  showAlert({ type:'error', title:'حذف الحساب', msg:`هل تريد حذف حساب ${name}؟ لن تُحذف مهامه.`, ok:'حذف', cancel:'إلغاء',
    onOk: async () => {
      try { await deleteDoc(doc(db,'users',uid)); await logEvent('delete_user',{targetUid:uid,name}); toast('success','تم حذف الحساب',''); }
      catch (e) { toast('error','خطأ',e.message); }
    }
  });
};

// ═══════════════════════════════════════════════════════
//  ASSIGN MODAL
// ═══════════════════════════════════════════════════════
function openAssignModal(targetUid='', targetName='') {
  const modal = document.getElementById('modal-assign');
  modal.classList.remove('hidden');
  const sel = document.getElementById('assign-emp-select');
  const empList = allUsers.filter(u=>!u.isAdmin || u.role==='both');
  sel.innerHTML = '<option value="">اختر الموظف...</option>' +
    empList.map(u=>`<option value="${u.uid}" ${u.uid===targetUid?'selected':''}>${u.name} — ${u.nationalId||''}</option>`).join('');
  document.getElementById('assign-target-name').textContent = targetName||'اختر موظفاً';
  sel.onchange = () => {
    const u = empList.find(x=>x.uid===sel.value);
    document.getElementById('assign-target-name').textContent = u?u.name:'اختر موظفاً';
  };
  const btn = document.getElementById('btn-assign-submit');
  const c = btn.cloneNode(true); btn.replaceWith(c);
  document.getElementById('btn-assign-submit').onclick = async () => {
    const empUid = document.getElementById('assign-emp-select').value;
    const type   = document.getElementById('assign-type').value;
    const qty    = document.getElementById('assign-qty').value.trim();
    const note   = document.getElementById('assign-note').value.trim();
    if (!empUid||!type||!qty) { toast('error','تنبيه','اختر موظفاً والصنف والكمية'); return; }
    const emp = allUsers.find(u=>u.uid===empUid);
    try {
      await setDoc(doc(collection(db,'tasks')),{
        taskId:genId(), status:'assigned', ownerUid:empUid,
        employeeName:emp?.name||'', nationalId:emp?.nationalId||'',
        type, assignedQty:qty, assignedNote:note, assignedBy:currentUser.name,
        assignedByUid:currentUser.uid, createdAt:serverTimestamp(),
        store:'—', beforeUrl:null, afterUrl:null
      });
      await logEvent('assign_task',{toUid:empUid,toName:emp?.name,type,qty});
      toast('success',`تم إرسال المهمة إلى ${emp?.name} 📋`,'');
      modal.classList.add('hidden');
      ['assign-emp-select','assign-type','assign-qty','assign-note'].forEach(id=>{document.getElementById(id).value='';});
    } catch (e) { toast('error','خطأ',e.message); }
  };
}
window.openAssignModal = openAssignModal;

// ═══════════════════════════════════════════════════════
//  TASK MODAL
// ═══════════════════════════════════════════════════════
window.openTaskModal = function(taskId) {
  const t = allTasks.find(x=>x.id===taskId); if (!t) return;
  const ia  = currentUser.isAdmin;
  const sim = t.similarity && t.similarity>=85;
  document.getElementById('modal-task-content').innerHTML = `
    <div class="mt-section">
      <h4><i class="fa-solid fa-fingerprint"></i> رقم المهمة</h4>
      <div style="font-size:16px;font-weight:900;color:var(--gold)">${t.taskId||t.id.substr(0,12)}</div>
      <div style="margin-top:6px">
        <span class="${statusClass(t.status)}"><i class="fa-solid ${statusIcon(t.status)}"></i> ${statusLabel(t.status)}</span>
        ${t.assignedQty?`<span style="margin-right:8px;font-size:12px;color:var(--gold)"><i class="fa-solid fa-hashtag"></i> الكمية: <strong>${t.assignedQty}</strong></span>`:''}
      </div>
    </div>
    ${sim?`<div class="warning-similar" style="margin-bottom:10px"><i class="fa-solid fa-triangle-exclamation"></i> تحذير: الصورتان متشابهتان ${t.similarity}%</div>`:''}
    ${t.lastLeftAt?`<div class="absence-banner"><i class="fa-solid fa-clock-rotate-left"></i><div>غادر الموظف المهمة في: <strong>${fmtDateFull(t.lastLeftAt)}</strong><br>${t.lastReturnedAt?`عاد في: <strong>${fmtDateFull(t.lastReturnedAt)}</strong> — مدة الغياب: <strong>${t.lastAbsenceDuration||'—'}</strong>`:'لم يعد بعد'}</div></div>`:''}
    <div class="mt-section">
      <h4><i class="fa-solid fa-user"></i> بيانات الموظف</h4>
      <div class="mt-grid">
        <div class="mt-item"><div class="mt-item-label">الاسم</div><div class="mt-item-val">${t.employeeName||'—'}</div></div>
        <div class="mt-item"><div class="mt-item-label">الرقم الوطني</div><div class="mt-item-val">${t.nationalId||'—'}</div></div>
      </div>
    </div>
    <div class="mt-section">
      <h4><i class="fa-solid fa-briefcase"></i> بيانات المهمة</h4>
      <div class="mt-grid">
        <div class="mt-item"><div class="mt-item-label">الصنف</div><div class="mt-item-val">${t.type||'—'}</div></div>
        <div class="mt-item"><div class="mt-item-label">الكمية</div><div class="mt-item-val">${t.assignedQty||'—'}</div></div>
        <div class="mt-item"><div class="mt-item-label">وقت البداية</div><div class="mt-item-val">${fmtDate(t.startTime)}</div></div>
        <div class="mt-item"><div class="mt-item-label">وقت النهاية</div><div class="mt-item-val">${fmtDate(t.endTime)}</div></div>
        <div class="mt-item"><div class="mt-item-label">مدة التنفيذ الفعلي</div><div class="mt-item-val">${t.duration?fmtTime(t.duration):'—'}</div></div>
        <div class="mt-item"><div class="mt-item-label">التاريخ</div><div class="mt-item-val">${fmtDate(t.createdAt)}</div></div>
        ${t.assignedNote?`<div class="mt-item" style="grid-column:1/-1"><div class="mt-item-label">ملاحظة المسؤول</div><div class="mt-item-val">${t.assignedNote}</div></div>`:''}
      </div>
    </div>
    ${t.rejectReason?`<div class="mt-section"><div class="warning-similar" style="background:rgba(192,57,43,.08);border-color:rgba(192,57,43,.25);color:var(--red)"><i class="fa-solid fa-xmark"></i> سبب الرفض: ${t.rejectReason}</div></div>`:''}
    ${(t.beforeUrl||t.afterUrl)?`
    <div class="mt-section">
      <h4><i class="fa-solid fa-images"></i> الصور — اسحب للمقارنة</h4>
      ${t.beforeUrl&&t.afterUrl?`
      <div class="compare-slider-wrap" id="csw">
        <img class="cs-base" src="${t.beforeUrl}" alt="قبل"/>
        <div class="cs-after-clip" id="cs-clip"><img src="${t.afterUrl}" alt="بعد"/></div>
        <div class="cs-handle-line" id="cs-hl"><div class="cs-handle-btn">⟺</div></div>
        <span class="cs-lbl cs-lbl-right">قبل</span><span class="cs-lbl cs-lbl-left">بعد</span>
      </div>`:''}
      <div class="mt-images">
        ${t.beforeUrl?`<div class="mt-img-wrap"><img src="${t.beforeUrl}" onclick="window.openLightbox(this.src)" alt="قبل"/><div class="mt-img-label">قبل التنفيذ</div></div>`:''}
        ${t.afterUrl?`<div class="mt-img-wrap"><img src="${t.afterUrl}"  onclick="window.openLightbox(this.src)" alt="بعد"/><div class="mt-img-label">بعد التنفيذ</div></div>`:''}
      </div>
    </div>`:''}
    <div class="mt-section">
      <h4><i class="fa-solid fa-timeline"></i> السجل الزمني</h4>
      <div class="timeline">${buildTimeline(t)}</div>
    </div>
    ${ia&&t.status==='pending'?`
    <div class="mt-section">
      <h4><i class="fa-solid fa-gavel"></i> القرار</h4>
      <div style="display:flex;gap:7px;flex-wrap:wrap">
        <button class="btn-approve" onclick="window.approveTask('${t.id}');document.getElementById('modal-task').classList.add('hidden')"><i class="fa-solid fa-check"></i> اعتماد</button>
        <button class="btn-amend"   onclick="window.amendTask('${t.id}');document.getElementById('modal-task').classList.add('hidden')"><i class="fa-solid fa-pen"></i> تعديل</button>
        <button class="btn-reject"  onclick="window.rejectTask('${t.id}')"><i class="fa-solid fa-xmark"></i> رفض</button>
      </div>
      <div class="reject-reason-input hidden" id="reject-reason-wrap">
        <textarea id="reject-reason-txt" placeholder="اكتب سبب الرفض..."></textarea>
        <button class="btn-reject btn-full" style="margin-top:7px" onclick="window.confirmReject('${t.id}')"><i class="fa-solid fa-xmark"></i> تأكيد الرفض</button>
      </div>
    </div>`:
    ia&&t.status==='approved'?`
    <div class="mt-section">
      <button class="btn-delete-task" onclick="window.deleteApprovedTask('${t.id}','${t.taskId||t.id}')"><i class="fa-solid fa-trash"></i> حذف هذه المهمة</button>
    </div>`:
    !ia&&t.status==='inprogress'&&t.ownerUid===currentUser.uid?`
    <div class="mt-section">
      <button class="btn-approve btn-full" onclick="window.resumeLeftTask('${t.id}');document.getElementById('modal-task').classList.add('hidden')"><i class="fa-solid fa-rotate-left"></i> إكمال هذه المهمة</button>
    </div>`:''}
  `;
  document.getElementById('modal-task').classList.remove('hidden');
  if (t.beforeUrl&&t.afterUrl) setTimeout(initSlider, 80);
};

function buildTimeline(t) {
  const ev = [];
  if (t.createdAt)      ev.push({label:'بدأ / أُسند', time:fmtDate(t.createdAt), details:null});
  if (t.beforeUploaded) ev.push({label:'رفع صورة "قبل"', time:fmtDate(t.beforeUploaded), details:null});
  if (t.pausedAt)       ev.push({label:`⏸ أوقف مؤقتاً`, time:fmtDate(t.pausedAt), details:t.pausedElapsed?`الوقت المنقضي: ${t.pausedElapsed}`:null});
  if (t.resumedAt)      ev.push({label:'▶️ استأنف', time:fmtDate(t.resumedAt), details:null});
  if (t.lastLeftAt)     ev.push({label:'🚪 غادر (إكمال لاحقاً)', time:fmtDate(t.lastLeftAt), details:null});
  if (t.lastReturnedAt) ev.push({label:'↩️ عاد للمهمة', time:fmtDate(t.lastReturnedAt), details:t.lastAbsenceDuration?`مدة الغياب: ${t.lastAbsenceDuration}`:null});
  if (t.endTime)        ev.push({label:'انتهى من التنفيذ', time:fmtDate(t.endTime), details:t.duration?`المدة الفعلية: ${fmtTime(t.duration)}`:null});
  if (t.afterUploaded)  ev.push({label:'رفع صورة "بعد"', time:fmtDate(t.afterUploaded), details:null});
  if (t.submittedAt)    ev.push({label:'أرسل للمراجعة', time:fmtDate(t.submittedAt), details:null});
  if (t.reviewedAt)     ev.push({label:t.status==='approved'?'✅ اعتمدها المسؤول':t.status==='rejected'?'❌ رفضها المسؤول':'✏️ طلب تعديل', time:fmtDate(t.reviewedAt), details:t.rejectReason||null});
  return ev.map(e=>`
    <div class="tl-item">
      <div class="tl-line"><div class="tl-dot"></div><div class="tl-tail"></div></div>
      <div class="tl-content">
        <div class="tl-label">${e.label}</div>
        <div class="tl-time">${e.time}</div>
        ${e.details?`<div class="tl-details">${e.details}</div>`:''}
      </div>
    </div>`).join('');
}

function initSlider() {
  const w=document.getElementById('csw'),clip=document.getElementById('cs-clip'),hl=document.getElementById('cs-hl');
  if (!w||!clip||!hl) return;
  let drag=false;
  const setP=x=>{const r=w.getBoundingClientRect(),p=Math.max(0,Math.min(100,(x-r.left)/r.width*100));clip.style.clipPath=`inset(0 ${100-p}% 0 0)`;hl.style.left=p+'%';};
  w.addEventListener('mousedown',e=>{drag=true;setP(e.clientX);});
  w.addEventListener('touchstart',e=>{drag=true;setP(e.touches[0].clientX);},{passive:true});
  window.addEventListener('mousemove',e=>{if(drag)setP(e.clientX);});
  window.addEventListener('touchmove',e=>{if(drag)setP(e.touches[0].clientX);},{passive:true});
  window.addEventListener('mouseup',()=>drag=false);
  window.addEventListener('touchend',()=>drag=false);
}

// ── Admin task actions ────────────────────────────────
window.approveTask = async function(id) {
  try { await updateDoc(doc(db,'tasks',id),{status:'approved',reviewedAt:serverTimestamp(),reviewedBy:currentUser.name}); await logEvent('approve_task',{taskId:id}); toast('success','✅ تم الاعتماد',''); } catch(e){toast('error','خطأ',e.message);}
};
window.rejectTask = function() { document.getElementById('reject-reason-wrap')?.classList.remove('hidden'); };
window.confirmReject = async function(id) {
  const r=(document.getElementById('reject-reason-txt')?.value||'').trim();
  try { await updateDoc(doc(db,'tasks',id),{status:'rejected',rejectReason:r,reviewedAt:serverTimestamp(),reviewedBy:currentUser.name}); await logEvent('reject_task',{taskId:id,reason:r}); document.getElementById('modal-task').classList.add('hidden'); toast('error','❌ تم الرفض',''); } catch(e){toast('error','خطأ',e.message);}
};
window.amendTask = async function(id) {
  showAlert({type:'warning',title:'طلب تعديل',msg:'أدخل سبب طلب التعديل في حقل الرفض',ok:'حسناً',onOk:()=>{document.getElementById('reject-reason-wrap')?.classList.remove('hidden');}});
};

// ── Employee modal ────────────────────────────────────
window.openEmpModal = function(uid) {
  const eu=allUsers.find(u=>u.uid===uid), tasks=allTasks.filter(x=>x.ownerUid===uid);
  if (!eu&&!tasks.length) return;
  const name=eu?.name||tasks[0]?.employeeName||'—', natId=eu?.nationalId||tasks[0]?.nationalId||'—';
  const ap=tasks.filter(t=>t.status==='approved').length, pe=tasks.filter(t=>t.status==='pending').length, re=tasks.filter(t=>t.status==='rejected').length;
  const tr=tasks.length?Math.round(ap/tasks.length*100):100;
  document.getElementById('modal-emp-content').innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div class="emp-avatar" style="width:48px;height:48px;font-size:18px">${initials(name)}</div>
      <div><h2 style="font-size:16px;font-weight:900;color:var(--gold-l)">${name}</h2><p style="color:var(--t3);font-size:11px"><i class="fa-solid fa-id-card"></i> ${natId} &nbsp;|&nbsp; <i class="fa-solid fa-envelope"></i> ${eu?.email||'—'}</p></div>
    </div>
    <div class="stats-grid" style="margin-bottom:12px">
      <div class="stat-card glass-card"><div class="stat-icon approved"><i class="fa-solid fa-check"></i></div><div class="stat-info"><div class="stat-num">${ap}</div><div class="stat-label">معتمدة</div></div></div>
      <div class="stat-card glass-card"><div class="stat-icon pending"><i class="fa-solid fa-clock"></i></div><div class="stat-info"><div class="stat-num">${pe}</div><div class="stat-label">مراجعة</div></div></div>
      <div class="stat-card glass-card"><div class="stat-icon rejected"><i class="fa-solid fa-xmark"></i></div><div class="stat-info"><div class="stat-num">${re}</div><div class="stat-label">مرفوضة</div></div></div>
    </div>
    <div class="trust-card glass-card" style="margin-bottom:12px;padding:13px">
      <div class="trust-header"><span><i class="fa-solid fa-star"></i> نسبة الثقة</span><span class="trust-value">${tr}%</span></div>
      <div class="trust-bar-bg"><div class="trust-bar-fill" style="width:${tr}%"></div></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${tasks.map(x=>`<div class="task-mini-card" onclick="window.openTaskModal('${x.id}');document.getElementById('modal-employee').classList.add('hidden')">
        <div class="task-mini-id">${x.taskId||x.id.substr(0,8)}</div>
        <div class="task-mini-info"><div class="task-mini-name">${x.type||'—'}${x.assignedQty?' ('+x.assignedQty+')':''}</div><div class="task-mini-sub">${fmtDate(x.createdAt)} · ${x.duration?fmtTime(x.duration):'—'}</div></div>
        <span class="${statusClass(x.status)}">${statusLabel(x.status)}</span>
      </div>`).join('')}
    </div>`;
  document.getElementById('modal-employee').classList.remove('hidden');
};

// ═══════════════════════════════════════════════════════
//  MONITOR
// ═══════════════════════════════════════════════════════
const LOG_MAP = {
  login:{icon:'fa-right-to-bracket',cls:'log-login',label:'سجّل الدخول'},
  logout:{icon:'fa-right-from-bracket',cls:'log-logout',label:'سجّل الخروج'},
  register:{icon:'fa-user-plus',cls:'log-login',label:'أنشأ حساباً'},
  start_task:{icon:'fa-play',cls:'log-task',label:'بدأ مهمة'},
  submit_task:{icon:'fa-paper-plane',cls:'log-task',label:'أرسل مهمة'},
  approve_task:{icon:'fa-check',cls:'log-admin',label:'اعتمد مهمة'},
  reject_task:{icon:'fa-xmark',cls:'log-admin',label:'رفض مهمة'},
  amend_task:{icon:'fa-pen',cls:'log-admin',label:'طلب تعديل'},
  assign_task:{icon:'fa-paper-plane',cls:'log-admin',label:'أسند مهمة'},
  delete_task:{icon:'fa-trash',cls:'log-admin',label:'حذف مهمة'},
  role_change:{icon:'fa-user-shield',cls:'log-admin',label:'غيّر صلاحية'},
  delete_user:{icon:'fa-user-xmark',cls:'log-admin',label:'حذف حساب'},
  leave_task:{icon:'fa-door-open',cls:'log-task',label:'غادر مهمة'},
  return_task:{icon:'fa-rotate-left',cls:'log-task',label:'عاد لمهمة'}
};
function renderMonitor() {
  if (!currentUser.isAdmin) return;
  const s=(document.getElementById('mon-search').value||'').toLowerCase();
  const fA=document.getElementById('mon-filter-action').value;
  let logs=[...allLogs];
  if (s)  logs=logs.filter(l=>(l.name||'').toLowerCase().includes(s)||(LOG_MAP[l.action]?.label||l.action).toLowerCase().includes(s));
  if (fA) logs=logs.filter(l=>l.action===fA);
  const el=document.getElementById('monitor-list');
  if (!logs.length) { el.innerHTML='<div class="empty-state"><i class="fa-solid fa-eye-slash"></i><p>لا يوجد نشاط مسجّل</p></div>'; document.getElementById('mon-pagination').innerHTML=''; return; }
  const start=(monitorPage-1)*PAGE_SIZE;
  el.innerHTML=logs.slice(start,start+PAGE_SIZE).map(l=>{
    const m=LOG_MAP[l.action]||{icon:'fa-circle-info',cls:'',label:l.action};
    const d=l.details||{};
    let det='';
    if(d.type)   det+=`<span><i class="fa-solid fa-tag"></i>${d.type}</span>`;
    if(d.taskId) det+=`<span><i class="fa-solid fa-fingerprint"></i>${d.taskId}</span>`;
    if(d.toName) det+=`<span><i class="fa-solid fa-user"></i>→ ${d.toName}</span>`;
    if(d.reason) det+=`<span><i class="fa-solid fa-comment"></i>${d.reason.substr(0,40)}</span>`;
    if(d.newRole) det+=`<span><i class="fa-solid fa-user-shield"></i>${d.newRole==='both'?'موظف+مسؤول':d.newRole==='admin'?'مسؤول':'موظف'}</span>`;
    return `
    <div class="log-item">
      <div class="log-icon ${m.cls}"><i class="fa-solid ${m.icon}"></i></div>
      <div class="log-body">
        <div class="log-action"><strong>${l.name||'—'}</strong> — ${m.label}</div>
        ${det?`<div class="log-meta">${det}</div>`:''}
      </div>
      <div class="log-time">${fmtDateFull(l.ts)}</div>
    </div>`;
  }).join('');
  renderPaginationBar('mon-pagination',logs.length,monitorPage,PAGE_SIZE,p=>{monitorPage=p;renderMonitor();});
}

// ═══════════════════════════════════════════════════════
//  START/RESUME ASSIGNED & LEFT TASKS
// ═══════════════════════════════════════════════════════
window.startAssignedTask = function(taskId) {
  const t=allTasks.find(x=>x.id===taskId); if(!t) return;
  document.getElementById('task-type').value='';
  currentFsId=taskId; currentTaskId=t.taskId||genId();
  // set type card selection
  const tc=document.querySelector(`.type-card[data-val="${t.type}"]`);
  if(tc){tc.click();}
  showPage('new-task'); setTimeout(()=>wizardGoStep(2),120);
};

window.resumeLeftTask = async function(taskId) {
  const t=allTasks.find(x=>x.id===taskId); if(!t) return;
  currentFsId=taskId; currentTaskId=t.taskId||genId();
  const saved=JSON.parse(localStorage.getItem('dopamine_resume_task')||'null');
  const isSame=saved&&saved.firestoreId===taskId;
  if(isSame){
    taskStartTime=new Date(saved.taskStartTime);
    totalPausedMs=saved.totalPausedMs+(Date.now()-saved.leftAt);
    beforeImgUrl=saved.beforeImgUrl||t.beforeUrl;
    localStorage.removeItem('dopamine_resume_task');
  } else {
    taskStartTime=t.startTime?.toDate?t.startTime.toDate():new Date();
    totalPausedMs=0;
    if(t.lastLeftAt){
      const lAt=t.lastLeftAt?.toDate?t.lastLeftAt.toDate().getTime():Date.now();
      totalPausedMs=Date.now()-lAt;
    }
    beforeImgUrl=t.beforeUrl;
  }
  const absMs=isSame?(Date.now()-saved.leftAt):totalPausedMs;
  try {
    await updateDoc(doc(db,'tasks',taskId),{lastReturnedAt:serverTimestamp(),lastAbsenceDuration:fmtTime(Math.floor(absMs/1000)),totalAbsenceMs:(t.totalAbsenceMs||0)+absMs});
    await logEvent('return_task',{taskId:currentTaskId,absenceMs:absMs});
  } catch {}
  // set type card
  const tc=document.querySelector(`.type-card[data-val="${t.type}"]`);
  if(tc) tc.click();
  showPage('new-task');
  setTimeout(()=>{
    wizardGoStep(3);
    document.getElementById('current-task-id').textContent=currentTaskId;
    document.getElementById('task-info-summary').innerHTML=`<span class="tag"><i class="fa-solid fa-tag"></i> ${t.type}</span><span class="tag"><i class="fa-solid fa-user"></i> ${currentUser.name}</span>`;
    isPaused=false;
    wizardStartTimerExt();
    toast('warning',`مرحباً بعودتك 👋`,`غبت: ${fmtTime(Math.floor(absMs/1000))} — تم احتسابها`,6000);
  },120);
};

function checkPendingResume() {
  if(currentUser.isAdmin) return;
  const s=JSON.parse(localStorage.getItem('dopamine_resume_task')||'null');
  if(!s) return;
  const t=allTasks.find(x=>x.id===s.firestoreId);
  if(t&&t.status==='inprogress') toast('warning','📋 لديك مهمة لم تكتمل',`${t.type} — من "مهامي"`,7000);
  else localStorage.removeItem('dopamine_resume_task');
}

// ═══════════════════════════════════════════════════════
//  WIZARD
// ═══════════════════════════════════════════════════════
function initWizard() {
  const panels={1:document.getElementById('ws-1'),2:document.getElementById('ws-2'),3:document.getElementById('ws-3'),4:document.getElementById('ws-4'),5:document.getElementById('ws-5'),done:document.getElementById('ws-done')};
  function goStep(n){
    Object.values(panels).forEach(p=>p?.classList.add('hidden'));
    panels[n==='done'?'done':n]?.classList.remove('hidden');
    if(typeof n==='number') document.querySelectorAll('.wstep').forEach(s=>{const sn=parseInt(s.dataset.step);s.classList.toggle('active',sn===n);s.classList.toggle('done',sn<n);});
  }
  wizardGoStep=goStep;

  // Type card selection
  document.querySelectorAll('.type-card').forEach(card=>{
    card.addEventListener('click',()=>{
      document.querySelectorAll('.type-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('task-type').value=card.dataset.val;
      document.getElementById('type-selected-val').textContent=card.dataset.val;
      document.getElementById('type-selected-label').classList.remove('hidden');
      document.getElementById('ws1-next').disabled=false;
    });
  });
  document.getElementById('ws1-next').onclick=()=>{
    if(!document.getElementById('task-type').value){toast('error','تنبيه','اختر الصنف أولاً');return;}
    goStep(2);
  };

  // Upload setup (paste + drag + click)
  function setupUpload(zoneId, inputId, isBeforeImg){
    const zone=document.getElementById(zoneId), input=document.getElementById(inputId);
    const nextBtnId=isBeforeImg?'ws2-next':'ws4-next';
    const previewId=isBeforeImg?'preview-before':'preview-after';
    const wrapId=isBeforeImg?'preview-before-wrap':'preview-after-wrap';
    zone.addEventListener('click',()=>input.click());
    ['dragover','dragenter'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add('dragover');}));
    ['dragleave','dragend'].forEach(ev=>zone.addEventListener(ev,()=>zone.classList.remove('dragover')));
    zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragover');handleFile(e.dataTransfer.files[0]);});
    input.addEventListener('change',()=>handleFile(input.files[0]));
    // Global paste on active step
    document.addEventListener('paste',async e=>{
      const activePanel=isBeforeImg?panels[2]:panels[4];
      if(activePanel?.classList.contains('hidden')) return;
      const items=e.clipboardData?.items||[];
      for(const item of items){
        if(item.type.startsWith('image/')){handleFile(item.getAsFile());break;}
      }
    });
    async function handleFile(file){
      if(!file||!file.type.startsWith('image/')){toast('error','خطأ','اختر صورة صالحة');return;}
      const h=await hashFile(file);
      if(isBeforeImg&&h===afterHash){toast('error','خطأ','لا يمكن استخدام نفس صورة "بعد"');return;}
      if(!isBeforeImg&&h===beforeHash){toast('error','خطأ','لا يمكن رفع نفس صورة "قبل"');return;}
      if(isBeforeImg){beforeHash=h;beforeImgBlob=file;}else{afterHash=h;afterImgBlob=file;}
      const reader=new FileReader(); reader.onload=e=>{
        document.getElementById(previewId).src=e.target.result;
        document.getElementById(wrapId).classList.remove('hidden');
        zone.classList.add('hidden');
        document.getElementById(nextBtnId).disabled=false;
      }; reader.readAsDataURL(file);
    }
    const removeBtn=document.getElementById(isBeforeImg?'remove-before':'remove-after');
    if(removeBtn) removeBtn.onclick=()=>{
      document.getElementById(wrapId).classList.add('hidden');
      zone.classList.remove('hidden');
      document.getElementById(nextBtnId).disabled=true;
      input.value='';
      if(isBeforeImg){beforeImgBlob=null;beforeHash=null;}else{afterImgBlob=null;afterHash=null;}
    };
  }
  setupUpload('upload-before-zone','upload-before',true);
  setupUpload('upload-after-zone','upload-after',false);

  document.getElementById('ws2-back').onclick=()=>goStep(1);
  document.getElementById('ws2-next').onclick=async()=>{
    if(!beforeImgBlob){toast('error','تنبيه','يجب رفع صورة "قبل"');return;}
    goStep(3); await startTask();
  };

  // Timer
  function startTimer(){
    clearInterval(timerInterval);
    timerInterval=setInterval(()=>{
      const s=Math.max(0,Math.floor((Date.now()-taskStartTime.getTime()-totalPausedMs)/1000));
      document.getElementById('live-timer').textContent=fmtTime(s);
    },1000);
  }
  wizardStartTimerExt=startTimer;

  // Pause
  document.getElementById('btn-pause').onclick=async()=>{
    if(isPaused) return;
    isPaused=true; pausedAt=Date.now(); clearInterval(timerInterval);
    const el=Math.max(0,Math.floor((pausedAt-taskStartTime.getTime()-totalPausedMs)/1000));
    document.getElementById('pause-elapsed').textContent=fmtTime(el);
    document.getElementById('pause-box').classList.add('active');
    document.getElementById('btn-pause').classList.add('hidden');
    document.getElementById('btn-resume').classList.remove('hidden');
    toast('warning','⏸ إيقاف مؤقت',`الوقت المنقضي: ${fmtTime(el)}`);
    if(currentFsId) try{await updateDoc(doc(db,'tasks',currentFsId),{status:'paused',pausedAt:serverTimestamp(),pausedElapsed:fmtTime(el)});}catch{}
  };
  document.getElementById('btn-resume').onclick=async()=>{
    if(!isPaused) return;
    totalPausedMs+=(Date.now()-pausedAt); isPaused=false; pausedAt=null;
    document.getElementById('pause-box').classList.remove('active');
    document.getElementById('btn-pause').classList.remove('hidden');
    document.getElementById('btn-resume').classList.add('hidden');
    startTimer(); toast('success','▶️ تم الاستئناف','');
    if(currentFsId) try{await updateDoc(doc(db,'tasks',currentFsId),{status:'inprogress',resumedAt:serverTimestamp()});}catch{}
  };

  // Complete Later
  document.getElementById('btn-complete-later').onclick=async()=>{
    if(!currentFsId||!taskStartTime){toast('error','خطأ','لا توجد مهمة نشطة');return;}
    clearInterval(timerInterval);
    const el=Math.max(0,Math.floor((Date.now()-taskStartTime.getTime()-totalPausedMs)/1000));
    localStorage.setItem('dopamine_resume_task',JSON.stringify({
      firestoreId:currentFsId, taskId:currentTaskId,
      taskStartTime:taskStartTime.getTime(), totalPausedMs, leftAt:Date.now(), beforeImgUrl
    }));
    try {
      await withTimeout(updateDoc(doc(db,'tasks',currentFsId),{status:'inprogress',lastLeftAt:serverTimestamp(),elapsedAtLeave:el}),8000,'الحفظ');
      await logEvent('leave_task',{taskId:currentTaskId,elapsedAtLeave:el});
      toast('info','تم حفظ تقدّمك ⏳',`الوقت المنقضي: ${fmtTime(el)} — يمكنك الإكمال من "مهامي"`,6000);
    } catch(e){toast('error','خطأ',e.message);}
    // Reset
    currentTaskId=null;taskStartTime=null;totalPausedMs=0;isPaused=false;currentFsId=null;
    beforeImgBlob=null;beforeImgUrl=null;beforeHash=null;
    showPage('dashboard');
  };

  // Start task
  async function startTask(){
    const type=document.getElementById('task-type').value;
    const store=document.getElementById('task-store')?.value||'—';
    if(!currentTaskId) currentTaskId=genId();
    taskStartTime=new Date(); totalPausedMs=0; isPaused=false;
    document.getElementById('current-task-id').textContent=currentTaskId;
    document.getElementById('task-info-summary').innerHTML=`<span class="tag"><i class="fa-solid fa-tag"></i> ${type}</span><span class="tag"><i class="fa-solid fa-user"></i> ${currentUser.name}</span>`;
    startTimer();
    toast('info','جاري معالجة الصورة...','');
    try {
      const b64=await withTimeout(processImage(beforeImgBlob,{name:currentUser.name,nationalId:currentUser.nationalId,store,type,taskId:currentTaskId}),14000,'معالجة الصورة');
      beforeImgUrl=b64;
      if(currentFsId){
        await withTimeout(updateDoc(doc(db,'tasks',currentFsId),{status:'inprogress',beforeUrl:beforeImgUrl,startTime:serverTimestamp(),beforeUploaded:serverTimestamp(),employeeName:currentUser.name,nationalId:currentUser.nationalId,ownerUid:currentUser.uid}),12000,'الحفظ');
      } else {
        const nr=doc(collection(db,'tasks')); currentFsId=nr.id;
        await withTimeout(setDoc(nr,{taskId:currentTaskId,employeeName:currentUser.name,nationalId:currentUser.nationalId,ownerUid:currentUser.uid,store,type,status:'inprogress',beforeUrl:beforeImgUrl,afterUrl:null,startTime:serverTimestamp(),createdAt:serverTimestamp(),beforeUploaded:serverTimestamp(),duration:null,endTime:null,submittedAt:null,similarity:null}),12000,'الحفظ');
      }
      await logEvent('start_task',{taskId:currentTaskId,type});
      toast('success','بدأت المهمة! ✅',`رقم المهمة: ${currentTaskId}`);
    } catch(e){toast('error','خطأ في المعالجة',e.message);}
  }

  document.getElementById('ws3-done').onclick=()=>{clearInterval(timerInterval);goStep(4);};
  document.getElementById('ws4-back').onclick=()=>{goStep(3);if(!isPaused)startTimer();};
  document.getElementById('ws4-next').onclick=()=>{
    if(!afterImgBlob){toast('error','تنبيه','يجب رفع صورة "بعد"');return;}
    const type=document.getElementById('task-type').value;
    const dur=Math.max(0,Math.floor((Date.now()-taskStartTime.getTime()-totalPausedMs)/1000));
    document.getElementById('review-grid').innerHTML=`
      <div class="review-item"><div class="review-item-label">رقم المهمة</div><div class="review-item-val">${currentTaskId}</div></div>
      <div class="review-item"><div class="review-item-label">الموظف</div><div class="review-item-val">${currentUser.name}</div></div>
      <div class="review-item"><div class="review-item-label">الصنف</div><div class="review-item-val">${type}</div></div>
      <div class="review-item"><div class="review-item-label">المدة الفعلية</div><div class="review-item-val">${fmtTime(dur)}</div></div>
      <div class="review-item"><div class="review-item-label">التاريخ</div><div class="review-item-val">${new Date().toLocaleDateString('ar-SA')}</div></div>
      <div class="review-item"><div class="review-item-label">الوقت</div><div class="review-item-val">${new Date().toLocaleTimeString('ar-SA')}</div></div>`;
    document.getElementById('review-before').src=document.getElementById('preview-before').src;
    document.getElementById('review-after').src=document.getElementById('preview-after').src;
    goStep(5);
  };

  document.getElementById('ws5-submit').onclick=async()=>{
    const btn=document.getElementById('ws5-submit');
    btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> جاري الإرسال...';
    try {
      const type=document.getElementById('task-type').value;
      const store=document.getElementById('task-store')?.value||'—';
      const dur=Math.max(0,Math.floor((Date.now()-taskStartTime.getTime()-totalPausedMs)/1000));
      toast('info','معالجة صورة "بعد"...','');
      const b64=await withTimeout(processImage(afterImgBlob,{name:currentUser.name,nationalId:currentUser.nationalId,store,type,taskId:currentTaskId}),14000,'معالجة الصورة');
      afterImgUrl=b64;
      const sim=beforeImgUrl&&afterImgUrl?await calcSimilarity(beforeImgUrl,afterImgUrl):null;
      if(currentFsId) await withTimeout(updateDoc(doc(db,'tasks',currentFsId),{afterUrl:afterImgUrl,status:'pending',endTime:serverTimestamp(),afterUploaded:serverTimestamp(),submittedAt:serverTimestamp(),duration:dur,similarity:sim}),12000,'الحفظ');
      await logEvent('submit_task',{taskId:currentTaskId,type,dur,sim});
      toast('success','تم الإرسال! 🎉','أُرسلت مهمتك للمراجعة');
      goStep('done');
      beforeImgBlob=null;afterImgBlob=null;beforeImgUrl=null;afterImgUrl=null;beforeHash=null;afterHash=null;currentTaskId=null;taskStartTime=null;totalPausedMs=0;isPaused=false;currentFsId=null;
    } catch(e){toast('error','خطأ في الإرسال',e.message);btn.disabled=false;btn.innerHTML='<i class="fa-solid fa-paper-plane"></i> إرسال للمراجعة';}
  };

  document.getElementById('btn-new-another').onclick=()=>{
    document.getElementById('task-type').value='';
    document.querySelectorAll('.type-card').forEach(c=>c.classList.remove('selected'));
    document.getElementById('type-selected-label').classList.add('hidden');
    document.getElementById('ws1-next').disabled=true;
    ['preview-before-wrap','preview-after-wrap'].forEach(id=>document.getElementById(id).classList.add('hidden'));
    ['upload-before-zone','upload-after-zone'].forEach(id=>document.getElementById(id).classList.remove('hidden'));
    ['ws2-next','ws4-next'].forEach(id=>{document.getElementById(id).disabled=true;});
    document.getElementById('ws5-submit').disabled=false;
    document.getElementById('ws5-submit').innerHTML='<i class="fa-solid fa-paper-plane"></i> إرسال للمراجعة';
    document.getElementById('live-timer').textContent='00:00:00';
    document.getElementById('pause-box').classList.remove('active');
    document.getElementById('btn-pause').classList.remove('hidden');
    document.getElementById('btn-resume').classList.add('hidden');
    goStep(1);
  };
}

// ─── BOOT ────────────────────────────────────────────
initAuth();
