/* =========================================================
   DATA MODEL — now wired to the real backend (server.js + db.js)
   instead of in-memory mock arrays. Every function below keeps
   its original name and DOM behavior; only the data source changed.

   Base URL — update if your server runs on a different host/port.
========================================================== */
const API = 'http://localhost:3000/api';

let categories = []; // fetched from GET /api/categories on load
let catMeta = {
  "Bag":{icon:"fa-bag-shopping",bg:"linear-gradient(135deg,#5b4fe9,#8b7cff)",solid:"#5b4fe9"},
  "Clothing":{icon:"fa-shirt",bg:"linear-gradient(135deg,#8a6d3b,#c9a96e)",solid:"#a8642b"},
  "Documents":{icon:"fa-file-lines",bg:"linear-gradient(135deg,#7a4f1c,#c98a34)",solid:"#c98a34"},
  "Electronics":{icon:"fa-laptop",bg:"linear-gradient(135deg,#274b6b,#3f7fa8)",solid:"#3f7fa8"},
  "ID Card":{icon:"fa-id-badge",bg:"linear-gradient(135deg,#3f4b9e,#6c63f5)",solid:"#5b4fe9"},
  "Keys":{icon:"fa-key",bg:"linear-gradient(135deg,#8a6d3b,#c9a96e)",solid:"#8b3fe0"},
  "Other":{icon:"fa-box",bg:"linear-gradient(135deg,#5c5c6b,#8a8a99)",solid:"#5c5c6b"}
};

let items = [];           // current list shown on Home/Board (from GET /api/items)
let myClaims = [];        // claims I've made (from GET /api/users/me/claims)
let myClaimsReceived = []; // claims on items I reported (from GET /api/users/me/claims-received)
let adminItems = [];      // all items, for the admin table
let adminLogs = [];       // from GET /api/admin/logs
let detailClaims = [];    // claims on the item currently open in the details modal

let bookmarks = new Set();     // front-end-only favorites (no backend table for these)
let currentUser = null;        // in-memory only — no persistence across refresh, per SRS
let authToken = null;          // JWT returned by login, sent as Authorization: Bearer <token>

/* ---------- fetch helper ---------- */
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && authToken) {
    // Saved token expired or is no longer valid — log out cleanly instead of
    // leaving the UI stuck in a logged-in-looking but broken state.
    currentUser = null; authToken = null;
    localStorage.removeItem('findr_token'); localStorage.removeItem('findr_user');
    updateAuthUI();
    showToast("Your session expired. Please sign in again.");
  }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
  return data;
}

/* ---------- helpers ---------- */
function findItem(id){ return items.find(i=>i.id===id) || adminItems.find(i=>i.id===id); }
// Returns today's date as YYYY-MM-DD in the user's LOCAL timezone.
// (new Date().toISOString() converts to UTC first, which can silently show
// yesterday's date for anyone in a timezone ahead of UTC during early morning
// hours — e.g. IST is UTC+5:30, so this bug appeared before ~5:30 AM local time.)
function todayLocalISO(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function formatDate(d){ const dt=new Date(d); return isNaN(dt) ? d : dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
function initials(name){ return name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
// The stored status value stays 'lost' | 'found' | 'claimed' (matches the database and API).
// This only controls what's SHOWN to the user, since "claim" was renamed to "return" in the UI.
function statusLabel(status){ return status === 'claimed' ? 'RETURNED' : status.toUpperCase(); }
function thumbStyle(it){ const meta=catMeta[it.category]||catMeta.Other; return it.imageUrl ? `background-image:url('${it.imageUrl}');` : `background:${meta.bg};`; }

let toastTimer;
function showToast(msg){ const t=document.getElementById('toast'); document.getElementById('toastMsg').textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2900); }
function openModal(id){ document.getElementById(id).classList.add('show'); }
function closeModal(id){ document.getElementById(id).classList.remove('show'); }
function switchModal(a,b){ closeModal(a); openModal(b); }
document.querySelectorAll('.modal-overlay').forEach(ov=>ov.addEventListener('click', e=>{ if(e.target===ov) ov.classList.remove('show'); }));
function comingSoon(e,name){ if(e) e.preventDefault(); closeMobileNav(); showToast(`${name} page is coming soon!`); }

/* ---------- Categories nav dropdown ---------- */
function toggleCategoryDropdown(e){
  e.preventDefault(); e.stopPropagation();
  const menu = document.getElementById('categoryDropdownMenu');
  if(!menu.dataset.filled){
    menu.innerHTML = categories.map(c=>`<a href="#" onclick="selectCategoryFromNav(event,'${c}')"><i class="fa-solid ${catMeta[c].icon}"></i> ${c}</a>`).join('');
    menu.dataset.filled = '1';
  }
  menu.classList.toggle('show');
}
async function selectCategoryFromNav(e, cat){
  e.preventDefault();
  document.getElementById('categoryDropdownMenu').classList.remove('show');
  await showBoardPage(null,'all');
  document.getElementById('boardCategory').value = cat;
  renderBoard();
}
function toggleMobileNav(){ document.getElementById('navLinks').classList.toggle('mobile-show'); }
function closeMobileNav(){ document.getElementById('navLinks').classList.remove('mobile-show'); }
document.addEventListener('click', e=>{
  const dd = document.getElementById('categoriesDropdown');
  if(dd && !dd.contains(e.target)) document.getElementById('categoryDropdownMenu').classList.remove('show');
  const nav = document.getElementById('navLinks'), burger = document.getElementById('hamburgerBtn');
  if(nav && nav.classList.contains('mobile-show') && !nav.contains(e.target) && !burger.contains(e.target)) nav.classList.remove('mobile-show');
});

/* =========================================================
   AUTH — FR-1, FR-2   Wired to: POST /api/auth/register, POST /api/auth/login
========================================================== */
async function handleRegister(e){
  e.preventDefault();
  const name=document.getElementById('regName').value.trim(), zprnId=document.getElementById('regZprn').value.trim(), password=document.getElementById('regPassword').value;
  if (!/^125U.{6}$/.test(zprnId)) { showToast("ZPRN ID must start with 125U and be exactly 10 characters."); return; }
  if (password.length < 6) { showToast("Password must be at least 6 characters long."); return; }
  try {
    await api('/auth/register', { method: 'POST', body: JSON.stringify({ name, zprnId, password }) });
    closeModal('registerModal'); e.target.reset();
    showToast("Account created! Please sign in.");
    document.getElementById('loginZprn').value = zprnId;
    openModal('loginModal');
  } catch (err) { showToast(err.message); }
}
async function handleLogin(e){
  e.preventDefault();
  const zprnId=document.getElementById('loginZprn').value.trim(), password=document.getElementById('loginPassword').value;
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ zprnId, password }) });
    authToken = data.token; currentUser = data.user;
    localStorage.setItem('findr_token', authToken);
    localStorage.setItem('findr_user', JSON.stringify(currentUser));
    updateAuthUI(); closeModal('loginModal'); e.target.reset();
    showToast(`Welcome back, ${currentUser.name.split(' ')[0]}!`);
    renderHome();
  } catch (err) { showToast(err.message); }
}
async function handleAdminLogin(e){
  e.preventDefault();
  const zprnId = document.getElementById('adminLoginZprn').value.trim();
  const password = document.getElementById('adminLoginPassword').value;
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ zprnId, password }) });
    if (data.user.role !== 'admin') { showToast("This ZPRN ID doesn't have admin access. Use Student Login instead."); return; }
    authToken = data.token; currentUser = data.user;
    localStorage.setItem('findr_token', authToken);
    localStorage.setItem('findr_user', JSON.stringify(currentUser));
    updateAuthUI(); closeModal('adminLoginModal'); e.target.reset();
    showToast(`Welcome, ${currentUser.name.split(' ')[0]}! Admin access granted.`);
    showPage(null,'admin');
  } catch (err) { showToast(err.message); }
}
function logout(){ currentUser=null; authToken=null; localStorage.removeItem('findr_token'); localStorage.removeItem('findr_user'); updateAuthUI(); showToast("Signed out."); showPage(null,'home'); }
function updateAuthUI(){
  const guest=document.getElementById('guestActions'), user=document.getElementById('userActions'), adminLink=document.getElementById('adminNavLink');
  if(currentUser){
    guest.classList.add('hidden'); user.classList.remove('hidden');
    document.getElementById('navAvatar').textContent = initials(currentUser.name);
    document.getElementById('navUserName').innerHTML = currentUser.name + (currentUser.role==='admin' ? ' <span class="admin-tag">ADMIN</span>' : ` <span class="pts-tag">★ ${currentUser.points}</span>`);
    document.getElementById('navUserZprn').textContent = currentUser.zprnId;
    adminLink.classList.toggle('hidden', currentUser.role!=='admin');
  } else { guest.classList.remove('hidden'); user.classList.add('hidden'); adminLink.classList.add('hidden'); }
}

/* =========================================================
   NAVIGATION
========================================================== */
async function showPage(e, page){
  if(e) e.preventDefault();
  closeMobileNav();
  if(page==='myitems' && !currentUser){ showToast("Please sign in first."); openModal('loginModal'); return; }
  if(page==='admin' && (!currentUser || currentUser.role!=='admin')){ showToast("Admin access only."); return; }
  ['home','board','report','myitems','admin','about'].forEach(p=>document.getElementById(p+'Page').classList.toggle('hidden', p!==page));
  document.getElementById('trustBar').classList.toggle('hidden', page!=='report');
  document.querySelectorAll('.nav-links a[data-page]').forEach(a=>a.classList.toggle('active', a.dataset.page===page));
  if(page==='home') await renderHome();
  if(page==='myitems'){ await showDashSection('overview'); }
  if(page==='admin') await renderAdmin();
  window.scrollTo(0,0);
}
async function showBoardPage(e, filter){
  if(e) e.preventDefault();
  closeMobileNav();
  await showPage(null,'board');
  document.querySelectorAll('.nav-links a[data-page]').forEach(a=>a.classList.toggle('active', a.dataset.page==='board-'+filter));
  const cfg = {
    all:{t:"The Board",s:"Browse everything reported as lost or found on campus.",i:"fa-clipboard-list",bg:"linear-gradient(120deg,var(--indigo-50),#eef0ff)"},
    lost:{t:"Lost Items",s:"Can't find something? You might find it here.",i:"fa-backpack",bg:"linear-gradient(120deg,#ffeef0,#fff5f6)"},
    found:{t:"Found Items",s:"Spotted something? Help reunite it with its owner.",i:"fa-box-open",bg:"linear-gradient(120deg,#dff7ec,#eafff4)"}
  }[filter] || {t:"The Board",s:"",i:"fa-clipboard-list",bg:""};
  document.getElementById('boardTitle').textContent = cfg.t;
  document.getElementById('boardSub').textContent = cfg.s;
  document.getElementById('boardIcon').innerHTML = `<i class="fa-solid ${cfg.i}"></i>`;
  document.getElementById('boardHero').style.background = cfg.bg;
  document.getElementById('boardStatus').value = (filter==='all') ? '' : filter;
  await renderBoard();
}

/* =========================================================
   HOME
========================================================== */
async function renderHome(){
  if(document.getElementById('homeSearchCategory').options.length <= 1) populateSelect('homeSearchCategory','All Categories');
  try { items = await api('/items'); } catch (err) { showToast(err.message); return; }
  const catCounts = {}; items.forEach(it=>catCounts[it.category]=(catCounts[it.category]||0)+1);
  document.getElementById('homeCategories').innerHTML = Object.keys(catMeta).map(cat=>{
    const m = catMeta[cat];
    return `<div class="cat-card" onclick="filterFromHome('${cat}')"><div class="cat-icon" style="background:${m.solid};"><i class="fa-solid ${m.icon}"></i></div><div><b>${cat}</b><span>${catCounts[cat]||0} Items</span></div></div>`;
  }).join('');
  document.getElementById('homeGrid').innerHTML = items.slice().sort((a,b)=>new Date(b.dateReported)-new Date(a.dateReported)).slice(0,5).map(itemCardHTML).join('');
}
async function filterFromHome(cat){ await showBoardPage(null,'all'); document.getElementById('boardCategory').value=cat; renderBoard(); }
async function homeSearch(){
  const q = document.getElementById('homeSearchInput').value;
  const cat = document.getElementById('homeSearchCategory').value;
  await showBoardPage(null,'all');
  document.getElementById('boardSearch').value = q;
  document.getElementById('boardCategory').value = cat;
  renderBoard();
}

/* =========================================================
   BOARD — FR-4, FR-12   Wired to: GET /api/items?status=&category=&location=&q=
========================================================== */
function populateSelect(id, label){ document.getElementById(id).innerHTML = `<option value="">${label}</option>` + categories.map(c=>`<option>${c}</option>`).join(''); }
function populateLocations(id){
  const el = document.getElementById(id);
  const current = el.value;
  const locs=[...new Set(items.map(i=>i.location).filter(Boolean))].sort();
  el.innerHTML = '<option value="">All Locations</option>' + locs.map(l=>`<option ${l===current?'selected':''}>${l}</option>`).join('');
}
function itemCardHTML(it){
  const meta = catMeta[it.category] || catMeta.Other;
  const bm = bookmarks.has(it.id);
  return `<div class="item-card">
    <div class="item-thumb" style="${thumbStyle(it)}" onclick="viewDetails(${it.id})">
      ${it.imageUrl ? '' : `<i class="fa-solid ${meta.icon}"></i>`}
      <span class="status-badge ${it.status}">${statusLabel(it.status)}</span>
      <button class="bookmark-btn ${bm?'active':''}" onclick="event.stopPropagation();toggleBookmark(${it.id})"><i class="fa-${bm?'solid':'regular'} fa-bookmark"></i></button>
    </div>
    <div class="item-body">
      <h4 onclick="viewDetails(${it.id})">${it.itemName}</h4>
      <div class="meta"><i class="fa-solid fa-location-dot"></i> ${it.location}</div>
      <div class="meta"><i class="fa-regular fa-calendar"></i> ${formatDate(it.dateReported)}</div>
      <div class="item-actions">
        <span class="view-link" onclick="viewDetails(${it.id})">View Details</span>
        <button class="bookmark-outline ${bm?'active':''}" onclick="toggleBookmark(${it.id})"><i class="fa-${bm?'solid':'regular'} fa-bookmark"></i></button>
      </div>
    </div>
  </div>`;
}
async function renderBoard(){
  if(document.getElementById('boardCategory').options.length <= 1) populateSelect('boardCategory','All Categories');

  const q=document.getElementById('boardSearch').value.trim(), status=document.getElementById('boardStatus').value, cat=document.getElementById('boardCategory').value, loc=document.getElementById('boardLocation').value;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (cat) params.set('category', cat);
  if (loc) params.set('location', loc);
  if (q) params.set('q', q);

  try { items = await api(`/items?${params.toString()}`); } catch (err) { showToast(err.message); return; }

  populateLocations('boardLocation');
  document.getElementById('boardChips').innerHTML = categories.map(c=>{
    const count = items.filter(i=>i.category===c).length;
    const active = document.getElementById('boardCategory').value===c ? 'active':'';
    return `<div class="chip ${active}" onclick="chipFilter('${c}')"><i class="fa-solid ${catMeta[c].icon}"></i> ${c} (${count})</div>`;
  }).join('');

  const list = items.slice().sort((a,b)=>new Date(b.dateReported)-new Date(a.dateReported));
  document.getElementById('boardGrid').innerHTML = list.length ? list.map(itemCardHTML).join('') : `<div class="empty-state"><i class="fa-regular fa-folder-open"></i>No items match. Try clearing your filters.</div>`;
  document.getElementById('boardCount').textContent = `Showing ${list.length} items`;
}
function chipFilter(cat){ const sel=document.getElementById('boardCategory'); sel.value = sel.value===cat?'':cat; renderBoard(); }

/* ---------- Bookmarks / Favorites (front-end only — no backend table for these) ---------- */
function toggleBookmark(itemId){
  if(bookmarks.has(itemId)) bookmarks.delete(itemId); else bookmarks.add(itemId);
  if(!document.getElementById('homePage').classList.contains('hidden')) renderHome();
  if(!document.getElementById('boardPage').classList.contains('hidden')) renderBoard();
  if(!document.getElementById('myitemsPage').classList.contains('hidden')) renderFavorites();
  if(document.getElementById('detailsModal').classList.contains('show') && activeDetailItemId===itemId) updateDetailBookmarkIcon(itemId);
}
function updateDetailBookmarkIcon(itemId){
  const bm = bookmarks.has(itemId);
  const btn = document.getElementById('detailBookmarkBtn');
  btn.classList.toggle('active', bm);
  btn.innerHTML = `<i class="fa-${bm?'solid':'regular'} fa-bookmark"></i>`;
}
function renderFavorites(){
  const list = items.filter(it=>bookmarks.has(it.id));
  document.getElementById('favoritesGrid').innerHTML = list.length ? list.map(itemCardHTML).join('') : `<div class="empty-state"><i class="fa-regular fa-star"></i>No favorites yet — tap the bookmark icon on any item to save it here.</div>`;
}

/* =========================================================
   ITEM DETAILS + CLAIM — FR-5, FR-6
   Wired to: GET /api/items/:id, GET /api/items/:id/claims, POST /api/items/:id/claims
========================================================== */
let activeDetailItemId = null;
async function viewDetails(itemId){
  activeDetailItemId = itemId;
  let it;
  try {
    it = await api(`/items/${itemId}`);
    detailClaims = await api(`/items/${itemId}/claims`);
  } catch (err) { showToast(err.message); return; }

  const meta = catMeta[it.category] || catMeta.Other;
  document.getElementById('detailThumb').setAttribute('style', thumbStyle(it));
  document.getElementById('detailThumb').innerHTML = `${it.imageUrl?'':`<i class="fa-solid ${meta.icon}"></i>`}<span class="status-badge ${it.status}" style="top:12px;left:12px;">${statusLabel(it.status)}</span>`;
  document.getElementById('detailName').textContent = it.itemName;
  document.getElementById('detailCategory').textContent = it.category;
  document.getElementById('detailLoc').textContent = it.location;
  document.getElementById('detailDate').textContent = formatDate(it.dateReported);
  document.getElementById('detailReporter').textContent = it.reportedByName || 'Unknown';
  document.getElementById('detailContact').textContent = it.contactInfo||'—';
  const claimCount = detailClaims.length;
  document.getElementById('detailClaimCount').textContent = `${claimCount} return request${claimCount===1?'':'s'} submitted so far`;
  if(it.description){ document.getElementById('detailDescWrap').style.display='flex'; document.getElementById('detailDesc').textContent=it.description; }
  else document.getElementById('detailDescWrap').style.display='none';
  updateDetailBookmarkIcon(itemId);
  const btn = document.getElementById('detailClaimBtn');
  const hasPendingClaim = detailClaims.some(c => c.status === 'pending');
  // Found item = someone found it, you're claiming it's yours.
  // Lost item = someone lost it, you have it, you're returning it to them.
  const actionWord = it.status === 'found' ? 'Claim' : 'Return';
  if(it.status==='claimed'){ btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-circle-check"></i> Already Resolved'; }
  else if(currentUser && currentUser.id===it.reportedBy){ btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-user"></i> This Is Your Report'; }
  else if(hasPendingClaim){ btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-hourglass-half"></i> Pending Review'; }
  else { btn.disabled=false; btn.innerHTML=`<i class="fa-regular fa-hand"></i> ${actionWord} This Item`; }
  openModal('detailsModal');
}
function openClaimModal(){
  if(!currentUser){ closeModal('detailsModal'); showToast("Please sign in to submit a request."); openModal('loginModal'); return; }
  closeModal('detailsModal');
  const it = findItem(activeDetailItemId);
  const actionWord = it && it.status === 'found' ? 'Claim' : 'Return';
  document.getElementById('claimModalTitle').textContent = `Submit a ${actionWord} Request`;
  document.getElementById('claimSub').textContent = `${actionWord === 'Claim' ? 'Claiming' : 'Returning'}: ${it?.itemName || ''}`;
  document.getElementById('claimSubmitBtn').innerHTML = `<i class="fa-regular fa-paper-plane"></i> Submit ${actionWord} Request`;
  openModal('claimModal');
}
async function handleClaimSubmit(e){
  e.preventDefault();
  const message = document.getElementById('claimMessage').value.trim();
  const contactInfo = document.getElementById('claimContactInfo').value.trim();
  if(!/^\d{10}$/.test(contactInfo)){ showToast("Contact number must be exactly 10 digits."); return; }
  try {
    await api(`/items/${activeDetailItemId}/claims`, { method: 'POST', body: JSON.stringify({ claimMessage: message, contactInfo }) });
    closeModal('claimModal'); e.target.reset();
    showToast("Return request submitted! The reporter will review it.");
    await renderBoard(); await renderHome();
  } catch (err) { showToast(err.message); }
}

/* =========================================================
   REPORT WIZARD — FR-3, FR-12 (+ Update via editingItemId)
   Wired to: POST /api/items or PUT /api/items/:id
========================================================== */
let wizType='found', currentStep=1, editingItemId=null, wizImages=[];
function startWizard(type, editItemId=null){
  if(!currentUser){ showToast("Please sign in to report an item."); openModal('loginModal'); return; }
  wizType=type; editingItemId=editItemId; currentStep=1; wizImages=[];
  populateSelect('wCategory','Select category');
  document.getElementById('wDescription').value=''; document.getElementById('charCount').textContent='0/300';
  document.getElementById('wItemName').value=''; document.getElementById('wLocation').value='';
  document.getElementById('wContact').value = currentUser.contactInfo || '';
  const todayStr = todayLocalISO();
  document.getElementById('wDate').max = todayStr;
  document.getElementById('wDate').value = todayStr;
  if(editItemId){
    const it = findItem(editItemId);
    if (it) {
      document.getElementById('wCategory').value = it.category;
      document.getElementById('wItemName').value = it.itemName;
      document.getElementById('wDescription').value = it.description || '';
      document.getElementById('charCount').textContent = (it.description||'').length + '/300';
      document.getElementById('wLocation').value = it.location;
      document.getElementById('wDate').value = (it.dateReported || '').slice(0,10) || todayStr;
      document.getElementById('wContact').value = it.contactInfo;
      wizType = it.status === 'found' ? 'found' : 'lost';
      if(it.imageUrl) wizImages = [it.imageUrl];
    }
  }
  const hero = document.getElementById('wizHero'); hero.className = 'wiz-hero ' + wizType;
  if(wizType==='found'){
    document.getElementById('wizHeroTitle').innerHTML = "Found Something?<br><span class=\"accent\">Let's Reunite It!</span>";
    document.getElementById('wizHeroSub').textContent = "Thank you for helping! Please provide details about the item you found so we can return it to its owner.";
    document.getElementById('wizHeroIcon').className = 'fa-solid fa-box-open';
    document.getElementById('pointsLine').style.display='flex';
  } else {
    document.getElementById('wizHeroTitle').innerHTML = "Lost Something?<br><span class=\"accent\">We'll Help Find It!</span>";
    document.getElementById('wizHeroSub').textContent = "Don't worry — fill in the details below and the campus community will help you find it.";
    document.getElementById('wizHeroIcon').className = 'fa-solid fa-backpack';
    document.getElementById('pointsLine').style.display='none';
  }
  document.getElementById('pvLocLbl').textContent = wizType==='found' ? 'Found Location' : 'Lost Location';
  document.getElementById('pvDateLbl').textContent = wizType==='found' ? 'Date Found' : 'Date Lost';
  renderUploadRow();
  showPage(null,'report');
  renderStepIndicator(); renderStepContent(); updatePreview();
}
const STEP_LABELS = [{t:"Item Details",s:"Describe the item"},{t:"Where & When",s:"Location & Time"},{t:"Your Details",s:"Contact Information"},{t:"Review & Submit",s:"Confirm & Post"}];
function renderStepIndicator(){
  document.getElementById('stepIndicator').innerHTML = STEP_LABELS.map((s,i)=>{
    const n=i+1; const cls = n<currentStep?'done':n===currentStep?'active':'';
    const circle = n<currentStep ? '<i class="fa-solid fa-check"></i>' : n;
    const line = n<4 ? '<div class="step-line"></div>' : '';
    return `<div class="step-item ${cls}"><div class="step-circle">${circle}</div><div><b>${s.t}</b><span>${s.s}</span></div></div>${line}`;
  }).join('');
}
function renderStepContent(){
  document.querySelectorAll('#wizForm .tab-panel').forEach((p,i)=>p.classList.toggle('show', i+1===currentStep));
  document.getElementById('wizBackBtn').style.visibility = currentStep===1 ? 'hidden' : 'visible';
  const nextBtn = document.getElementById('wizNextBtn');
  if(currentStep===4){ nextBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> ${editingItemId?'Save Changes':'Submit Report'}`; nextBtn.classList.add('btn-green'); nextBtn.onclick=submitWizard; renderReview(); }
  else { nextBtn.innerHTML = 'Next <i class="fa-solid fa-arrow-right"></i>'; nextBtn.classList.remove('btn-green'); nextBtn.onclick=()=>goStep(1); }
}
function validateStep(step){
  if(step===1){ if(!document.getElementById('wCategory').value||!document.getElementById('wItemName').value.trim()||!document.getElementById('wDescription').value.trim()){ showToast("Please fill in category, item name and description."); return false; } }
  if(step===2){
    if(!document.getElementById('wLocation').value.trim()||!document.getElementById('wDate').value){ showToast("Please fill in location and date."); return false; }
    if(document.getElementById('wDate').value > todayLocalISO()){ showToast("Date can't be in the future."); return false; }
  }
  if(step===3){
    const contact = document.getElementById('wContact').value.trim();
    if(!contact){ showToast("Please add your contact info."); return false; }
    if(!/^\d{10}$/.test(contact)){ showToast("Contact number must be exactly 10 digits."); return false; }
  }
  return true;
}
function goStep(dir){
  if(dir===1 && !validateStep(currentStep)) return;
  const next = currentStep+dir; if(next<1||next>4) return;
  currentStep = next; renderStepIndicator(); renderStepContent(); window.scrollTo(0,0);
}
function renderReview(){
  const rows = [['Status', wizType.toUpperCase()],['Category', document.getElementById('wCategory').value],['Item Name', document.getElementById('wItemName').value],['Description', document.getElementById('wDescription').value],['Location', document.getElementById('wLocation').value],['Date', formatDate(document.getElementById('wDate').value)],['Contact Info', document.getElementById('wContact').value],['Photos', wizImages.length + ' attached']];
  document.getElementById('reviewList').innerHTML = rows.map(([k,v])=>`<div class="review-item"><span class="k">${k}</span><span class="v">${v||'--'}</span></div>`).join('');
}
async function submitWizard(){
  const data = {
    itemName: document.getElementById('wItemName').value.trim(),
    description: document.getElementById('wDescription').value.trim(),
    category: document.getElementById('wCategory').value,
    location: document.getElementById('wLocation').value.trim(),
    contactInfo: document.getElementById('wContact').value.trim(),
    imageUrl: wizImages[0] || '',
    status: wizType,
    dateReported: document.getElementById('wDate').value
  };
  try {
    if(editingItemId){
      await api(`/items/${editingItemId}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast(`"${data.itemName}" updated successfully!`);
    } else {
      await api('/items', { method: 'POST', body: JSON.stringify(data) });
      showToast(`"${data.itemName}" reported successfully!`);
    }
    const wasEditing = !!editingItemId;
    editingItemId = null;
    await showPage(null, wasEditing ? 'myitems' : 'home');
  } catch (err) { showToast(err.message); }
}
function renderUploadRow(){
  let html = wizImages.map((src,i)=>`<div class="thumb-slot"><img src="${src}"><button type="button" class="rm" onclick="removeImage(${i})"><i class="fa-solid fa-xmark"></i></button></div>`).join('');
  if(wizImages.length < 3){
    html += `<div class="upload-zone" onclick="document.getElementById('fileInput').click()" ondragover="event.preventDefault();this.style.borderColor='var(--indigo-600)';" ondrop="handleDrop(event)">
      <i class="fa-solid fa-cloud-arrow-up"></i><span>Click to upload or drag &amp; drop</span><small>PNG, JPG up to 5MB · ${3-wizImages.length} left</small></div>`;
  }
  for(let i=wizImages.length+1; i<3; i++) html += `<div class="add-slot" onclick="document.getElementById('fileInput').click()"><i class="fa-solid fa-plus"></i>Add Photo</div>`;
  document.getElementById('uploadRow').innerHTML = html;
}
function handleFiles(fileList){
  [...fileList].slice(0, 3-wizImages.length).forEach(file=>{
    if(!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = ev=>{ wizImages.push(ev.target.result); renderUploadRow(); updatePreview(); };
    reader.readAsDataURL(file);
  });
}
function handleDrop(e){ e.preventDefault(); handleFiles(e.dataTransfer.files); }
function removeImage(i){ wizImages.splice(i,1); renderUploadRow(); updatePreview(); }
function updatePreview(){
  const cat = document.getElementById('wCategory').value;
  const meta = catMeta[cat] || catMeta.Other;
  const thumb = document.getElementById('previewThumb');
  if(wizImages[0]){ thumb.style.backgroundImage = `url('${wizImages[0]}')`; thumb.innerHTML=''; }
  else { thumb.style.backgroundImage=''; thumb.style.background = cat ? meta.bg : 'var(--ink-300)'; thumb.innerHTML = `<i class="fa-solid ${cat?meta.icon:'fa-image'}"></i>`; }
  document.getElementById('pvCategory').textContent = cat || '--';
  document.getElementById('pvName').textContent = document.getElementById('wItemName').value || '--';
  const desc = document.getElementById('wDescription').value;
  document.getElementById('pvDesc').textContent = desc ? (desc.length>60 ? desc.slice(0,60)+'…' : desc) : '--';
  document.getElementById('pvLoc').textContent = document.getElementById('wLocation').value || '--';
  const d = document.getElementById('wDate').value;
  document.getElementById('pvDate').textContent = d ? formatDate(d) : '--';
}

/* =========================================================
   DASHBOARD (sidebar layout) — FR-7, FR-8, FR-14 + rewards + CRUD (edit/delete)
   Wired to: GET /api/users/me/items|claims|claims-received,
             PATCH /api/claims/:id, PATCH /api/items/:id/resolve,
             PUT /api/items/:id (edit), DELETE /api/items/:id (owner)
========================================================== */
async function showDashSection(sec){
  document.querySelectorAll('.dash-side-link[data-sec]').forEach(b=>b.classList.toggle('active', b.dataset.sec===sec));
  document.querySelectorAll('#myitemsPage .tab-panel').forEach(p=>p.classList.toggle('show', p.id==='dsec-'+sec));
  await renderMyItems();
  window.scrollTo(0,0);
}
async function dashSearch(){
  const q = document.getElementById('dashSearchInput').value;
  await showBoardPage(null,'all');
  document.getElementById('boardSearch').value = q;
  renderBoard();
}
function sparkline(color, values){
  const w=100,h=28, max=Math.max(...values), min=Math.min(...values);
  const pts = values.map((v,i)=>`${(i/(values.length-1))*w},${h-((v-min)/((max-min)||1))*h}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
async function renderMyItems(){
  if(!currentUser) return;
  document.getElementById('welcomeName').textContent = `Welcome back, ${currentUser.name.split(' ')[0]}! 👋`;

  let myItems;
  try {
    myItems = await api('/users/me/items');
    myClaims = await api('/users/me/claims');
    myClaimsReceived = await api('/users/me/claims-received');
  } catch (err) { showToast(err.message); return; }

  const lostCount = myItems.filter(i=>i.status==='lost').length;
  const foundCount = myItems.filter(i=>i.status==='found').length;
  const claimedCount = myItems.filter(i=>i.status==='claimed').length;

  document.getElementById('dashStatGrid').innerHTML = `
    <div class="stat-card"><div class="top-row"><div class="ic" style="background:var(--red);"><i class="fa-solid fa-box-open"></i></div><div><div class="num">${lostCount}</div><div class="lbl">My Lost Reports</div></div></div>${sparkline('#e2364a',[2,3,2,4,3,5,lostCount||1])}</div>
    <div class="stat-card"><div class="top-row"><div class="ic" style="background:var(--green);"><i class="fa-solid fa-tag"></i></div><div><div class="num">${foundCount}</div><div class="lbl">My Found Reports</div></div></div>${sparkline('#1f9d63',[1,2,3,2,4,3,foundCount||1])}</div>
    <div class="stat-card"><div class="top-row"><div class="ic" style="background:var(--gray);"><i class="fa-solid fa-circle-check"></i></div><div><div class="num">${claimedCount}</div><div class="lbl">Items Resolved</div></div></div>${sparkline('#6b6885',[1,1,2,2,3,3,claimedCount||1])}</div>
    <div class="stat-card"><div class="top-row"><div class="ic" style="background:var(--gold);"><i class="fa-solid fa-star"></i></div><div><div class="num">${currentUser.points}</div><div class="lbl">Reward Points</div></div></div>${sparkline('#d98c1f',[10,15,20,25,28,32,currentUser.points||1])}</div>
  `;

  const total = myItems.length || 1;
  const lp=(lostCount/total)*100, fp=(foundCount/total)*100;
  document.getElementById('activityDonut').style.background = `conic-gradient(var(--red) 0% ${lp}%, var(--green) ${lp}% ${lp+fp}%, var(--gray) ${lp+fp}% 100%)`;
  document.getElementById('donutTotal').textContent = myItems.length;
  document.getElementById('legendLost').textContent = lostCount;
  document.getElementById('legendFound').textContent = foundCount;
  document.getElementById('legendClaimed').textContent = claimedCount;

  const recent = myItems.slice().sort((a,b)=>new Date(b.dateReported)-new Date(a.dateReported)).slice(0,4);
  document.getElementById('recentReports').innerHTML = recent.length ? recent.map(it=>{
    const meta = catMeta[it.category]||catMeta.Other;
    return `<div class="mini-report-row"><div class="mini-thumb" style="${thumbStyle(it)}">${it.imageUrl?'':`<i class="fa-solid ${meta.icon}"></i>`}</div><div><div class="nm">${it.itemName}</div><div class="sub">${it.status.charAt(0).toUpperCase()+it.status.slice(1)} · ${it.location}</div></div><span class="status-badge ${it.status} pill" style="position:static;">${statusLabel(it.status)}</span></div>`;
  }).join('') : `<div class="empty-state" style="padding:30px 10px;"><i class="fa-regular fa-folder-open"></i>No reports yet.</div>`;

  document.getElementById('recentActivityBody').innerHTML = myItems.slice(0,6).map(it=>{
    const meta = catMeta[it.category]||catMeta.Other;
    return `<tr><td><span class="row-thumb" style="${thumbStyle(it)}">${it.imageUrl?'':`<i class="fa-solid ${meta.icon}"></i>`}</span>${it.itemName}</td><td>${it.status==='claimed'?'—':it.status.charAt(0).toUpperCase()+it.status.slice(1)}</td><td><span class="status-pill ${it.status==='claimed'?'approved':it.status==='lost'?'rejected':'pending'}">${statusLabel(it.status)}</span></td><td>${formatDate(it.dateReported)}</td><td><a href="#" onclick="viewDetails(${it.id});return false;"><i class="fa-solid fa-chevron-right" style="color:var(--ink-300);"></i></a></td></tr>`;
  }).join('') || `<tr><td colspan="5" style="text-align:center;color:var(--ink-500);">No activity yet.</td></tr>`;

  document.getElementById('tab-reported').innerHTML = myItems.length ? myItems.map(it=>{
    const claimCount = myClaimsReceived.filter(c=>c.itemId===it.id).length;
    return `<div class="list-card">
      <div class="info"><h4>${it.itemName} <span class="status-badge ${it.status}" style="position:static;display:inline-block;">${statusLabel(it.status)}</span></h4>
      <div class="meta"><i class="fa-solid fa-location-dot"></i> ${it.location} · <i class="fa-regular fa-calendar"></i> ${formatDate(it.dateReported)} · ${claimCount} return request${claimCount===1?'':'s'}</div></div>
      <div class="actions">
        <button class="btn btn-outline btn-sm" onclick="viewDetails(${it.id})">View</button>
        ${it.status!=='claimed' ? `<button class="btn btn-outline btn-sm" onclick="startWizard('${it.status}',${it.id})"><i class="fa-solid fa-pen"></i> Edit</button>
        <button class="btn btn-green btn-sm" onclick="markResolved(${it.id})"><i class="fa-solid fa-circle-check"></i> Mark Resolved</button>` : ''}
        <button class="btn btn-red btn-sm" onclick="deleteOwnItem(${it.id})"><i class="fa-solid fa-trash"></i> Delete</button>
      </div></div>`;
  }).join('') : `<div class="empty-state"><i class="fa-regular fa-folder-open"></i>You haven't reported any items yet.</div>`;

  document.getElementById('tab-claimsmade').innerHTML = myClaims.length ? myClaims.map(c=>{
    return `<div class="list-card"><div class="info"><h4>${c.itemName || 'Item removed'} <span class="status-pill ${c.status}">${c.status.toUpperCase()}</span></h4>
      <div class="meta"><i class="fa-regular fa-calendar"></i> Claimed on ${formatDate(c.dateClaimed)}</div>${c.claimMessage?`<div class="claim-msg">"${c.claimMessage}"</div>`:''}</div></div>`;
  }).join('') : `<div class="empty-state"><i class="fa-regular fa-folder-open"></i>You haven't submitted any return requests yet.</div>`;

  document.getElementById('tab-approvals').innerHTML = myClaimsReceived.length ? myClaimsReceived.map(c=>{
    return `<div class="list-card"><div class="info"><h4>${c.itemName || 'Item removed'} <span class="status-pill ${c.status}">${c.status.toUpperCase()}</span></h4>
      <div class="meta"><i class="fa-regular fa-user"></i> Requested by ${c.claimantName || 'Unknown'} · <i class="fa-solid fa-phone"></i> ${c.contactInfo}</div>${c.claimMessage?`<div class="claim-msg">"${c.claimMessage}"</div>`:''}</div>
      <div class="actions">${c.status==='pending' ? `<button class="btn btn-green btn-sm" onclick="approveClaim(${c.id})"><i class="fa-solid fa-check"></i> Approve</button><button class="btn btn-red btn-sm" onclick="rejectClaim(${c.id})"><i class="fa-solid fa-xmark"></i> Reject</button>` : ''}</div></div>`;
  }).join('') : `<div class="empty-state"><i class="fa-regular fa-folder-open"></i>No return requests on your items yet.</div>`;

  renderFavorites();
  await renderLeaderboard();
}
async function renderLeaderboard(){
  let ranked;
  try { ranked = await api('/leaderboard'); } catch (err) { showToast(err.message); return; }
  document.getElementById('tab-leaderboard').innerHTML = `<div style="font-size:12.5px;color:var(--ink-500);margin-bottom:14px;">Earn points by reporting found items and returning them to their owners.</div>` +
    (ranked.map((u,i)=>{
      const rankClass = i===0?'gold':i===1?'silver':i===2?'bronze':'';
      return `<div class="leader-row"><div class="rank ${rankClass}">${i+1}</div><div class="avatar">${initials(u.name)}</div><div><b>${u.name}</b>${currentUser && u.id===currentUser.id?' <span style="color:var(--indigo-600);font-weight:700;">(You)</span>':''}</div><div class="pts">★ ${u.points} pts</div></div>`;
    }).join('') || `<div class="empty-state"><i class="fa-solid fa-trophy"></i>No champions yet.</div>`);
}
async function markResolved(itemId){
  try {
    const data = await api(`/items/${itemId}/resolve`, { method: 'PATCH' });
    if (data.pointsAwarded) {
      currentUser.points += data.pointsAwarded; updateAuthUI();
      showToast(`🎉 +${data.pointsAwarded} points — returned a found item`);
    } else {
      showToast('Item marked as resolved.');
    }
    await renderMyItems();
  } catch (err) { showToast(err.message); }
}
async function approveClaim(claimId){
  try {
    const data = await api(`/claims/${claimId}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
    if (data.pointsAwarded) {
      currentUser.points += data.pointsAwarded; updateAuthUI();
      showToast(`🎉 +${data.pointsAwarded} points — returned a found item to its owner`);
    } else {
      showToast('Return approved. Item marked as returned.');
    }
    await renderMyItems();
  } catch (err) { showToast(err.message); }
}
async function rejectClaim(claimId){
  try {
    await api(`/claims/${claimId}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) });
    showToast('Return request rejected.');
    await renderMyItems();
  } catch (err) { showToast(err.message); }
}
async function deleteOwnItem(itemId){
  const it = findItem(itemId);
  if(!confirm(`Delete "${it ? it.itemName : 'this item'}"? This cannot be undone.`)) return;
  try {
    await api(`/items/${itemId}`, { method: 'DELETE' });
    showToast('Item deleted.');
    await renderMyItems();
  } catch (err) { showToast(err.message); }
}

/* =========================================================
   ADMIN — FR-10, FR-11, FR-13
   Wired to: GET /api/admin/stats|logs, DELETE /api/admin/items/:id
========================================================== */
async function renderAdmin(){
  let stats;
  try {
    stats = await api('/admin/stats');
    adminItems = await api('/items?includeOld=1');
    adminLogs = await api('/admin/logs');
  } catch (err) { showToast(err.message); return; }

  document.getElementById('statTotalItems').textContent = stats.totalItems;
  document.getElementById('statTotalClaims').textContent = stats.totalClaims;
  document.getElementById('statResolved').textContent = stats.resolvedItems;
  document.getElementById('statTotalUsers').textContent = stats.totalUsers;
  document.getElementById('adminItemsBody').innerHTML = adminItems.map(it=>{
    return `<tr><td>${it.itemName}</td><td>${it.category}</td><td><span class="status-badge ${it.status}" style="position:static;display:inline-block;">${statusLabel(it.status)}</span></td><td>${it.reportedByName || 'Unknown'}</td><td>${formatDate(it.dateReported)}</td><td><button class="btn btn-red btn-sm" onclick="adminRemoveItem(${it.id})"><i class="fa-solid fa-trash"></i> Remove</button></td></tr>`;
  }).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--ink-500);">No items on the platform.</td></tr>`;
  document.getElementById('adminLogBody').innerHTML = adminLogs.map(l=>{
    return `<tr><td>${new Date(l.timestamp).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</td><td>${l.adminName}</td><td>${l.action}</td><td>${l.itemName}</td></tr>`;
  }).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--ink-500);">No admin actions logged yet.</td></tr>`;
}
async function adminRemoveItem(itemId){
  const it = adminItems.find(i=>i.id===itemId);
  if(!confirm(`Remove "${it ? it.itemName : 'this item'}" from the platform? This cannot be undone.`)) return;
  try {
    await api(`/admin/items/${itemId}`, { method: 'DELETE' });
    showToast(`Item removed from the platform.`);
    await renderAdmin();
  } catch (err) { showToast(err.message); }
}

/* ---------- INIT ---------- */
(async function init(){
  // Restore a previous login session, if one was saved (so refreshing the page doesn't log you out).
  const savedToken = localStorage.getItem('findr_token');
  const savedUser = localStorage.getItem('findr_user');
  if (savedToken && savedUser) {
    try {
      authToken = savedToken;
      currentUser = JSON.parse(savedUser);
      updateAuthUI();
    } catch (err) {
      // Corrupted saved session — clear it rather than get stuck in a broken logged-in-looking state.
      localStorage.removeItem('findr_token');
      localStorage.removeItem('findr_user');
    }
  }

  try {
    const cats = await api('/categories');
    categories = cats.map(c => c.name);
  } catch (err) {
    // Backend not reachable yet — fall back to the static category list so the UI still renders.
    categories = Object.keys(catMeta);
    showToast("Couldn't reach the server — is it running on localhost:3000?");
  }
  renderHome();
})();