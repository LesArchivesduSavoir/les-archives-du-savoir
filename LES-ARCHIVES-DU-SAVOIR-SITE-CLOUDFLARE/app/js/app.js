const $ = (selector) => document.querySelector(selector);

const state = {
  mode: "login",
  user: null,
  selectedColor: "#6f263d",
  coverImageData: null,
  editingNotebookId: null,
  currentNotebook: null,
  currentPage: 1,
  totalPages: 120,
  zoom: 100,
  pageSaveTimers: {},
  pageSaveQueues: {},
  dirtyPages: {},
  navigating: false,
  librarySection: "home",
  libraryRequestId: 0,
  pageCache: {}
};

let savedEditorRange = null;

const loadingScreen = $("#loading-screen");
const authView = $("#auth-view");
const libraryView = $("#library-view");
const authForm = $("#auth-form");
const authError = $("#auth-error");
const createDialog = $("#create-dialog");

function showView(view) {
  loadingScreen.classList.add("hidden");
  authView.classList.toggle("hidden", view !== "auth");
  libraryView.classList.toggle("hidden", view !== "library");
  $("#reader-view").classList.toggle("hidden", view !== "reader");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 2800);
}

async function api(path, options = {}) {
  if (window.archivesDesktop) {
    const result = await window.archivesDesktop.request(path, {method: options.method || "GET", ...(options.body !== undefined ? {body: options.body} : {}), ...(options.rememberLogin === true ? {rememberLogin:true} : {})});
    if (!result.ok) throw new Error(result.data.error || "Une erreur est survenue.");
    return result.data;
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Une erreur est survenue.");
  return data;
}

function setAuthMode(mode) {
  state.mode = mode;
  const registering = mode === "register";
  $("#auth-eyebrow").textContent = registering ? "REJOIGNEZ LES ARCHIVES" : "VOTRE BIBLIOTHÈQUE PERSONNELLE";
  $("#auth-title").textContent = registering ? "Créer votre compte" : "Bienvenue";
  $("#auth-subtitle").textContent = registering
    ? "Créez votre espace personnel pour commencer votre collection."
    : "Connectez-vous pour retrouver vos carnets.";
  $("#display-name-wrap").classList.toggle("hidden", !registering);
  $("#remember-login-wrap").classList.toggle("hidden", registering || !window.archivesDesktop);
  $("#display-name").required = registering;
  $("#password").autocomplete = registering ? "new-password" : "current-password";
  $("#auth-submit").textContent = registering ? "Créer mon compte" : "Se connecter";
  $("#auth-switch-label").textContent = registering ? "Vous avez déjà un compte ?" : "Vous n'avez pas encore de compte ?";
  $("#auth-switch").textContent = registering ? "Se connecter" : "Créer un compte";
  authError.textContent = "";
}

$("#auth-switch").addEventListener("click", () => setAuthMode(state.mode === "login" ? "register" : "login"));
if(window.archivesDesktop) {
  $("#auth-resend").classList.remove("hidden");
  $("#auth-resend").addEventListener("click", async () => {
    const button=$("#auth-resend"); button.disabled=true;
    try {
      const result=await api("/api/resend-verification",{method:"POST",body:JSON.stringify({email:$("#email").value.trim(),password:$("#password").value})});
      authError.textContent=result.alreadyVerified ? "Ton adresse est déjà vérifiée : tu peux te connecter." : "Lien envoyé. Vérifie tes e-mails et tes courriers indésirables.";
    } catch(error) {authError.textContent=error.message;}
    finally {button.disabled=false;}
  });
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.textContent = "";
  const submit = $("#auth-submit");
  submit.disabled = true;
  const payload = { email: $("#email").value.trim(), password: $("#password").value };
  if (state.mode === "register") payload.displayName = $("#display-name").value.trim();

  try {
    const result = await api(state.mode === "register" ? "/api/register" : "/api/login", {
      method: "POST", body: JSON.stringify(payload), rememberLogin:state.mode === "login" && $("#remember-login").checked
    });
    if (result.verificationRequired) {
      setAuthMode("login");
      authError.textContent = result.emailSent
        ? "Compte créé ! Consulte tes e-mails, clique sur le lien de vérification, puis connecte-toi."
        : "Compte créé, mais l’e-mail de vérification n’a pas pu être envoyé. Réessaie plus tard.";
      return;
    }
    state.user = result.user;
    await enterLibrary();
    if(result.sessionWarning) showToast(result.sessionWarning);
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

async function enterLibrary() {
  showView("library");
  $("#user-name").textContent = state.user.displayName;
  $("#user-email").textContent = state.user.email;
  $("#user-avatar").textContent = (state.user.displayName || "U").charAt(0).toUpperCase();
  await loadNotebooks();
  if (window.archivesDesktop?.drive) await refreshDriveStatus();
}

const libraryLabels = {home:"Ma bibliothèque", notebooks:"Mes carnets", favorites:"Favoris", bookmarks:"Marque-pages", recent:"Récents", trash:"Corbeille"};
async function openLibrarySection(section) {
  if (!libraryLabels[section]) return;
  if (state.currentNotebook && !(await flushAllPages())) return;
  state.currentNotebook = null;
  state.librarySection = section;
  showView("library");
  await loadNotebooks();
}
document.querySelectorAll("[data-library-nav], [data-reader-nav]").forEach(button => {
  button.addEventListener("click", () => openLibrarySection(button.dataset.libraryNav || button.dataset.readerNav));
});
async function loadNotebooks() {
  const grid = $("#notebook-grid"), empty = $("#empty-state"), section = state.librarySection;
  const requestId = ++state.libraryRequestId;
  grid.innerHTML = "";
  empty.classList.add("hidden");
  $("#library-title").textContent = libraryLabels[section];
  $("#library-section-title").textContent = section === "home" ? "Mes carnets" : libraryLabels[section];
  $(".welcome-strip").classList.toggle("hidden", section !== "home");
  document.querySelectorAll("[data-library-nav]").forEach(b => b.classList.toggle("active", b.dataset.libraryNav === section));
  try {
    const result = await api(`/api/notebooks${section === "trash" ? "?scope=trash" : ""}`);
    if (requestId !== state.libraryRequestId || section !== state.librarySection) return;
    let notebooks = result.notebooks || [];
    if (section === "favorites") notebooks = notebooks.filter(n => n.is_favorite);
    if (section === "recent") notebooks = notebooks.filter(n => n.last_opened_at).sort((a,b) => b.last_opened_at.localeCompare(a.last_opened_at));
    if (section === "bookmarks") {
      const data = await api("/api/bookmarks");
      if (requestId !== state.libraryRequestId || section !== state.librarySection) return;
      const entries = data.bookmarks || [];
      const byId = new Map(notebooks.map(n => [n.id,n]));
      $("#notebook-count").textContent = `${entries.length} marque-page${entries.length > 1 ? "s" : ""}`;
      for (const entry of entries) {
        const n = byId.get(entry.notebook_id); if (!n) continue;
        const article = document.createElement("article"); article.className="bookmark-library-card";
        const open=document.createElement("button"); open.className="bookmark-open"; open.type="button";
        const dot=document.createElement("i"); dot.style.backgroundColor=entry.color;
        const text=document.createElement("span"), title=document.createElement("strong"), subtitle=document.createElement("small");
        title.textContent=entry.label||"Sans titre"; subtitle.textContent=`${n.title} · page ${entry.page_number}`; text.append(title,subtitle); open.append(dot,text);
        open.addEventListener("click",()=>openNotebook(n, entry.page_number));
        const remove=document.createElement("button"); remove.type="button"; remove.className="bookmark-remove"; remove.textContent="Supprimer";
        remove.addEventListener("click",async()=>{if(!confirm("Supprimer ce marque-page ?"))return;try{await api(`/api/notebooks/${n.id}/bookmarks/${entry.id}`,{method:"DELETE"});await loadNotebooks();showToast("Marque-page supprimé.");}catch(e){showToast(e.message)}});
        article.append(open,remove);grid.append(article);
      }
      if (!entries.length) showLibraryEmpty("Aucun marque-page", "Ajoutez un marque-page depuis un carnet.", false);
      return;
    }
    $("#notebook-count").textContent = `${notebooks.length} carnet${notebooks.length > 1 ? "s" : ""}`;
    if (!notebooks.length) {
      const details = {home:["Votre bibliothèque est encore vide","Votre premier carnet n'attend que vous.",true],notebooks:["Aucun carnet","Créez votre premier carnet.",true],favorites:["Aucun favori","Ajoutez un carnet aux favoris depuis sa fiche.",false],recent:["Aucun carnet récent","Les carnets ouverts apparaîtront ici.",false],trash:["La corbeille est vide","Les carnets supprimés apparaîtront ici.",false]};
      showLibraryEmpty(...details[section]);
    }
    notebooks.forEach(notebook => grid.appendChild(createNotebookCard(notebook, section === "trash")));
  } catch (error) { if (requestId === state.libraryRequestId) { $("#notebook-count").textContent="Chargement impossible"; showToast(error.message); } }
}
function showLibraryEmpty(title, description, canCreate) {
  $("#empty-title").textContent=title; $("#empty-description").textContent=description;
  $("#empty-create-button").classList.toggle("hidden",!canCreate); $("#empty-state").classList.remove("hidden");
}

function createNotebookCard(notebook, inTrash = false) {
  const article = document.createElement("article");
  article.className = "notebook-card";

  const openButton = document.createElement("button");
  openButton.className = "notebook-open";
  openButton.type = "button";
  openButton.title = "Ouvrir " + notebook.title;

  const cover = document.createElement("div");
  cover.className = "book-cover";
  cover.style.backgroundColor = notebook.cover_color || "#6f263d";
  if (notebook.cover_image_data) {
    cover.style.backgroundImage = `linear-gradient(rgba(0,0,0,.28), rgba(0,0,0,.38)), url("${notebook.cover_image_data}")`;
    cover.style.backgroundSize = "cover";
    cover.style.backgroundPosition = "center";
  }

  const emblem = document.createElement("span");
  emblem.className = "cover-mini-emblem";
  emblem.textContent = "❧";
  const title = document.createElement("span");
  title.className = "cover-title";
  title.textContent = notebook.title;
  const rule = document.createElement("span");
  rule.className = "cover-rule";
  const subtitle = document.createElement("span");
  subtitle.className = "cover-subtitle";
  subtitle.textContent = "LES ARCHIVES DU SAVOIR";
  cover.append(emblem, title, rule, subtitle);
  openButton.appendChild(cover);
  if (!inTrash) openButton.addEventListener("click", () => openNotebook(notebook));
  else { openButton.disabled = true; openButton.title = "Carnet dans la corbeille"; }

  const info = document.createElement("div");
  info.className = "notebook-info";
  const infoTitle = document.createElement("strong");
  infoTitle.textContent = notebook.title;
  const description = document.createElement("p");
  description.textContent = notebook.description || "Aucune description";
  const meta = document.createElement("small");
  meta.textContent = `${notebook.page_count} page${notebook.page_count > 1 ? "s" : ""} · Créé le ${new Date(notebook.created_at).toLocaleDateString("fr-FR")}`;
  info.append(infoTitle, description, meta);

  const actions = document.createElement("div");
  actions.className = "notebook-actions";
  if (inTrash) {
    const restore=document.createElement("button"); restore.type="button"; restore.className="notebook-action"; restore.textContent="Restaurer";
    restore.addEventListener("click",async()=>{try{await api(`/api/notebooks/${notebook.id}/restore`,{method:"POST",body:"{}"});await loadNotebooks();showToast("Carnet restauré.");}catch(e){showToast(e.message)}});
    const permanent=document.createElement("button"); permanent.type="button"; permanent.className="notebook-action notebook-action-danger"; permanent.textContent="Supprimer définitivement";
    permanent.addEventListener("click",async()=>{if(!confirm(`Supprimer définitivement « ${notebook.title} » et toutes ses pages ? Cette action est irréversible.`))return;try{await api(`/api/notebooks/${notebook.id}/permanent`,{method:"DELETE"});await loadNotebooks();showToast("Carnet supprimé définitivement.");}catch(e){showToast(e.message)}});
    actions.append(restore,permanent);
  } else {
    const favorite=document.createElement("button"); favorite.type="button"; favorite.className="notebook-action"; favorite.textContent=notebook.is_favorite?"★ Favori":"☆ Favori";
    favorite.setAttribute("aria-pressed",String(Boolean(notebook.is_favorite)));
    favorite.addEventListener("click",async()=>{try{await api(`/api/notebooks/${notebook.id}/favorite`,{method:"PUT",body:JSON.stringify({favorite:!notebook.is_favorite})});await loadNotebooks();}catch(e){showToast(e.message)}});
    const edit=document.createElement("button");edit.type="button";edit.className="notebook-action";edit.textContent="Modifier";edit.addEventListener("click",()=>openEditDialog(notebook));
    const remove=document.createElement("button");remove.type="button";remove.className="notebook-action notebook-action-danger";remove.textContent="Corbeille";remove.addEventListener("click",()=>deleteNotebook(notebook));
    actions.append(favorite,edit,remove);
  }

  article.append(openButton, info, actions);
  return article;
}

function openCreateDialog() {
  state.editingNotebookId = null;
  state.selectedColor = "#6f263d";
  state.coverImageData = null;
  $("#dialog-title").textContent = "Créer un carnet";
  $("#create-form").reset();
  $("#cover-image-input").value = "";
  $("#remove-cover-image").classList.add("hidden");
  $("#create-error").textContent = "";
  updateColorSelection();
  updateCoverPreview();
  createDialog.showModal();
  $("#notebook-title").focus();
}

function openEditDialog(notebook) {
  state.editingNotebookId = notebook.id;
  state.selectedColor = notebook.cover_color || "#6f263d";
  state.coverImageData = notebook.cover_image_data || null;
  $("#dialog-title").textContent = "Modifier le carnet";
  $("#notebook-title").value = notebook.title;
  $("#notebook-description").value = notebook.description || "";
  $("#cover-image-input").value = "";
  $("#create-error").textContent = "";
  $("#remove-cover-image").classList.toggle("hidden", !state.coverImageData);
  updateColorSelection();
  $("#custom-color").value = state.selectedColor;
  $("#hex-color").value = state.selectedColor.toUpperCase();
  updateCoverPreview();
  createDialog.showModal();
}

function updateColorSelection() {
  document.querySelectorAll(".color-choice").forEach(button => {
    const selected = button.dataset.color.toLowerCase() === state.selectedColor.toLowerCase();
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $("#custom-color").value = state.selectedColor;
  $("#hex-color").value = state.selectedColor.toUpperCase();
}

function updateCoverPreview() {
  const preview = $("#cover-preview");
  preview.style.backgroundColor = state.selectedColor;
  preview.style.backgroundImage = state.coverImageData
    ? `linear-gradient(rgba(0,0,0,.22), rgba(0,0,0,.38)), url("${state.coverImageData}")`
    : "none";
  preview.style.backgroundSize = "cover";
  preview.style.backgroundPosition = "center";
  $("#cover-preview-title").textContent = $("#notebook-title").value.trim() || "MON CARNET";
  $("#remove-cover-image").classList.toggle("hidden", !state.coverImageData);
}

document.querySelectorAll(".color-choice").forEach(button => {
  button.addEventListener("click", () => {
    state.selectedColor = button.dataset.color;
    updateColorSelection();
    updateCoverPreview();
  });
});

$("#custom-color").addEventListener("input", event => {
  state.selectedColor = event.target.value.toUpperCase();
  updateColorSelection();
  updateCoverPreview();
});

$("#hex-color").addEventListener("change", event => {
  const value = event.target.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    state.selectedColor = value.toUpperCase();
    updateColorSelection();
    updateCoverPreview();
  } else {
    event.target.value = state.selectedColor.toUpperCase();
    showToast("Code HEX invalide. Exemple : #6F263D");
  }
});

$("#notebook-title").addEventListener("input", updateCoverPreview);

async function optimizeCoverImage(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choisis une image JPG, PNG ou WebP.");
  }
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    const maxSide = 1200;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let quality = 0.78;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > 850000 && quality > 0.4) {
      quality -= 0.08;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrl.length > 950000) throw new Error("Cette image est trop volumineuse. Essaie une image plus petite.");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

$("#cover-image-input").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    state.coverImageData = await optimizeCoverImage(file);
    updateCoverPreview();
    showToast("Image ajoutée à la couverture.");
  } catch (error) {
    event.target.value = "";
    showToast(error.message);
  }
});

$("#remove-cover-image").addEventListener("click", () => {
  state.coverImageData = null;
  $("#cover-image-input").value = "";
  updateCoverPreview();
  showToast("Image retirée de la couverture.");
});

function openCreateDialogFromButton() {
  $("#create-error").textContent = "";
  $("#create-form").reset();
  state.editingNotebookId = null;
  state.selectedColor = "#6f263d";
  state.coverImageData = null;
  $("#dialog-title").textContent = "Créer un carnet";
  updateColorSelection();
  updateCoverPreview();
  createDialog.showModal();
  $("#notebook-title").focus();
}

$("#new-notebook-button").addEventListener("click", openCreateDialogFromButton);
$("#empty-create-button").addEventListener("click", openCreateDialogFromButton);
$("#close-dialog").addEventListener("click", () => createDialog.close());
$("#cancel-create").addEventListener("click", () => createDialog.close());
createDialog.addEventListener("click", event => {
  if (event.target === createDialog) createDialog.close();
});

$("#create-form").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  $("#create-error").textContent = "";
  const payload = {
    title: $("#notebook-title").value.trim(),
    description: $("#notebook-description").value.trim(),
    coverColor: state.selectedColor,
    coverImageData: state.coverImageData
  };
  const isEditing = Boolean(state.editingNotebookId);

  try {
    await api(isEditing ? `/api/notebooks/${state.editingNotebookId}` : "/api/notebooks", {
      method: isEditing ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    createDialog.close();
    await loadNotebooks();
    showToast(isEditing ? "Carnet mis à jour." : "Votre carnet a été créé.");
  } catch (error) {
    $("#create-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

async function deleteNotebook(notebook) {
  const confirmed = window.confirm(`Placer « ${notebook.title} » dans la corbeille ? Vous pourrez le restaurer.`);
  if (!confirmed) return;
  try {
    await api(`/api/notebooks/${notebook.id}`, { method: "DELETE" });
    await loadNotebooks();
    showToast("Carnet placé dans la corbeille.");
  } catch (error) {
    showToast(error.message);
  }
}

async function logoutAccount() {
  if (window.archivesDesktop?.isDriveBusy?.()) { showToast("Attends la fin de la synchronisation avant de te déconnecter."); return; }
  if (state.currentNotebook && !(await flushAllPages())) {
    showToast("Déconnexion annulée : enregistre d’abord les modifications.");
    return;
  }
  let logoutWarning="";
  try { const result=await api("/api/logout", { method: "POST", body: "{}" }); logoutWarning=result.sessionWarning||""; } catch { logoutWarning="La déconnexion n’a pas pu être confirmée. Réessaie."; }
  Object.values(state.pageSaveTimers).forEach(clearTimeout);
  state.user = null;
  state.currentNotebook = null;
  state.pageCache = {}; state.dirtyPages = {}; state.pageSaveTimers = {}; state.pageSaveQueues = {};
  state.librarySection = "home";
  if ($("#account-dialog").open) $("#account-dialog").close();
  if (window.archivesDesktop?.drive) { setDriveConnected(false); $("#drive-status").textContent = "Connecte ton Drive pour envoyer ou récupérer ta bibliothèque."; }
  authForm.reset();
  setAuthMode("login");
  showView("auth");
  if(logoutWarning) authError.textContent=logoutWarning;
}
function openAccount() {
  if (!state.user) return;
  $("#account-name").textContent = state.user.displayName || "Utilisateur";
  $("#account-email").textContent = state.user.email || "";
  if (!$("#account-dialog").open) $("#account-dialog").showModal();
}
$("#account-open").addEventListener("click", openAccount);
$("#reader-account").addEventListener("click", openAccount);
$("#account-close").addEventListener("click", () => $("#account-dialog").close());
$("#account-signout").addEventListener("click", logoutAccount);
$("#logout-button").addEventListener("click", logoutAccount);

async function initialize() {
  try {
    const result = await api("/api/me");
    if(window.archivesDesktop) {
      $("#remember-login").disabled = result.rememberAvailable === false;
      $("#remember-login-info").classList.toggle("hidden", result.rememberAvailable !== false);
    }
    if (result.user) {
      state.user = result.user;
      await enterLibrary();
    } else {
      setAuthMode("login");
      if(result.sessionWarning) authError.textContent=result.sessionWarning;
      showView("auth");
    }
  } catch {
    setAuthMode("login");
    showView("auth");
  }
}

// Synchronisation manuelle : les jetons restent dans le processus principal.
let driveConnected=false, driveActionBusy=false;
function setDriveConnected(connected) {
  driveConnected=!!connected;
  $("#drive-connect").classList.toggle("hidden",driveConnected);
  $("#drive-disconnect").classList.toggle("hidden",!driveConnected);
  $("#drive-remember-label").classList.toggle("hidden",driveConnected);
  $("#drive-push").disabled=driveActionBusy||!driveConnected||window.archivesDesktop.driveSyncAvailable===false;
  $("#drive-pull").disabled=driveActionBusy||!driveConnected||window.archivesDesktop.driveSyncAvailable===false;
  $("#drive-connect").disabled=driveActionBusy;
  $("#drive-disconnect").disabled=driveActionBusy;
}
async function refreshDriveStatus() {
  try {
    const response=await window.archivesDesktop.drive('status');
    if(!response.ok)throw new Error(response.error);
    setDriveConnected(response.connected);
    $("#drive-status").textContent=response.message + (response.rememberAvailable===false && !response.connected ? " Le stockage sécurisé est indisponible : connexion temporaire uniquement." : "");
    $("#drive-remember").disabled=response.rememberAvailable===false;
    if(response.rememberAvailable===false) $("#drive-remember").checked=false;
  } catch(error) {setDriveConnected(false);$("#drive-status").textContent=error.message||'Connexion Drive indisponible.';}
}
if (window.archivesDesktop?.drive) {
  $("#drive-panel").classList.remove("hidden");
  async function driveAction(action) {
    if(driveActionBusy)return;
    driveActionBusy=true;setDriveConnected(driveConnected);
    const status=$("#drive-status");
    status.textContent=action==="connect" ? "Connexion à Google Drive…" : "Opération Drive en cours…";
    try {
      const response=await window.archivesDesktop.drive(action,{remember:$("#drive-remember").checked});
      if(!response.ok) {if(response.connected===false)setDriveConnected(false);throw new Error(response.error);}
      if(action==='connect'||action==='disconnect')setDriveConnected(response.connected);
      status.textContent=action==='connect'||action==='disconnect' ? response.message : action==='push' ? (response.result.unchanged ? "La bibliothèque est déjà à jour sur Google Drive." : "Bibliothèque envoyée sur Google Drive.") : response.result.unchanged ? "La bibliothèque est déjà à jour." : "Bibliothèque récupérée depuis Google Drive.";
      if(action==='pull') await loadNotebooks();
    } catch(error) {status.textContent=error.message||"Opération impossible.";}
    finally {driveActionBusy=false;setDriveConnected(driveConnected);}
  }
  $("#drive-connect").addEventListener("click",()=>driveAction("connect"));
  $("#drive-disconnect").addEventListener("click",()=>driveAction("disconnect"));
  $("#drive-push").addEventListener("click",()=>driveAction("push"));
  $("#drive-pull").addEventListener("click",()=>driveAction("pull"));
}

initialize();

// V2 — lecteur de carnet A5, édition et sauvegarde des pages
async function openNotebook(notebook, targetPage = 1) {
  state.currentNotebook = notebook;
  const page = Math.max(1, Math.min(120, Number(targetPage) || 1));
  state.currentPage = page % 2 ? page : page - 1;
  state.pageCache = {};
  state.dirtyPages = {};
  state.pageSaveTimers = {};
  state.pageSaveQueues = {};
  savedEditorRange = null;
  showView("reader");
  const hideInspector = window.innerWidth <= 850;
  $("#reader-view").classList.toggle("inspector-hidden", hideInspector);
  $("#reader-inspector-toggle").setAttribute("aria-expanded", String(!hideInspector));
  $("#reader-title").textContent = notebook.title;
  $("#reader-crumb-title").textContent = notebook.title;
  $("#inspector-title").textContent = notebook.title;
  $("#inspector-description").textContent = notebook.description || "Aucune description";
  $("#inspector-color").textContent = notebook.cover_color || "Personnalisée";
  $("#reader-user-name").textContent = state.user?.displayName || "Utilisateur";
  $("#reader-avatar").textContent = (state.user?.displayName || "U").charAt(0).toUpperCase();
  const color = notebook.cover_color || "#6f263d";
  $("#book-cover-shell").style.setProperty("--cover-color", color);
  $("#inspector-cover").style.backgroundColor = color;
  $("#reader-cover-thumb").style.backgroundColor = color;
  if (notebook.cover_image_data) {
    $("#inspector-cover").style.backgroundImage = `linear-gradient(#0003,#0005),url("${notebook.cover_image_data}")`;
    $("#reader-cover-thumb").style.backgroundImage = `url("${notebook.cover_image_data}")`;
  } else {
    $("#inspector-cover").style.backgroundImage = "";
    $("#reader-cover-thumb").style.backgroundImage = "";
  }
  await loadSpread();
  await loadBookmarks();
  try { await api(`/api/notebooks/${notebook.id}/opened`, {method:"POST", body:"{}"}); } catch(e) { showToast("Impossible d’ajouter aux récents : " + e.message); }
  // Mesure le lecteur après son affichage : le carnet ne dépend plus d’une largeur auto intrinsèque.
  requestAnimationFrame(() => { requestAnimationFrame(() => applyBookZoom()); });
}

async function loadPage(number) {
  if (state.pageCache[number] !== undefined) return state.pageCache[number];
  const result = await api(`/api/notebooks/${state.currentNotebook.id}/pages/${number}`);
  state.pageCache[number] = result.content || "";
  return state.pageCache[number];
}

async function loadSpread() {
  if (!state.currentNotebook) return;
  const left = state.currentPage;
  const right = Math.min(120, left + 1);
  try {
    const [a,b] = await Promise.all([loadPage(left), loadPage(right)]);
    $("#left-page-content").innerHTML = sanitizePageHtml(a);
    $("#right-page-content").innerHTML = sanitizePageHtml(b);
    hydrateImages($("#left-page-content")); hydrateImages($("#right-page-content"));
    selectEditorImage(null);
    $("#left-page-content").dataset.lastValidHtml = $("#left-page-content").innerHTML;
    $("#right-page-content").dataset.lastValidHtml = $("#right-page-content").innerHTML;
    savedEditorRange = null;
    $("#left-page-number").textContent = left;
    $("#right-page-number").textContent = right;
    $("#reader-page-label").textContent = `${left}–${right} / 120`;
    $("#reader-prev").disabled = left <= 1;
    $("#reader-prev-side").disabled = left <= 1;
    $("#reader-next").disabled = right >= 120;
    $("#reader-next-side").disabled = right >= 120;
    return true;
  } catch (error) { showToast(error.message); return false; }
}

// Jamais de HTML actif : le contenu historique est filtré avant affichage.
function sanitizePageHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const tags = new Set(["P","DIV","H1","H2","H3","BLOCKQUOTE","BR","FONT","SPAN","STRONG","B","EM","I","U","S","STRIKE","UL","OL","LI","A","IMG"]);
  const styles = new Set(["font-family","font-size","font-weight","font-style","text-decoration","text-align","color","background-color","line-height","margin","margin-top","margin-bottom","padding-left","border-left","width","height","position","left","top","display","margin-left","margin-right"]);
  function clean(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) { child.remove(); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (!tags.has(child.tagName)) { child.remove(); continue; }
      for (const attr of [...child.attributes]) {
        const n = attr.name.toLowerCase(), v = attr.value;
        if (n === "style") {
          const style = document.createElement("span").style;
          style.cssText = v;
          for (const prop of [...style]) if (!styles.has(prop) || /url\s*\(|expression|var\s*\(|[<>]/i.test(style.getPropertyValue(prop))) style.removeProperty(prop);
          child.setAttribute("style", style.cssText); continue;
        }
        if (n === "class" && child.tagName === "SPAN" && /^(editor-image-wrap|image-resize-handle)$/.test(v)) continue;
        if (n === "data-direction" && child.classList.contains("image-resize-handle") && /^(n|ne|e|se|s|sw|w|nw)$/.test(v)) continue;
        if (n === "tabindex" && child.classList.contains("editor-image-wrap") && v === "0") continue;
        if (n === "contenteditable" && v === "false" && child.classList.contains("editor-image-wrap")) continue;
        if (n === "src" && child.tagName === "IMG" && /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(v) && v.length <= 180000) continue;
        if (n === "href" && child.tagName === "A" && /^(https?:|mailto:)/i.test(v)) continue;
        if (["alt","title"].includes(n)) continue;
        if (child.tagName === "FONT" && ["face","color","size"].includes(n) && /^[\w ,#-]+$/.test(v)) continue;
        child.removeAttribute(attr.name);
      }
      if (child.tagName === "IMG" && !child.hasAttribute("src")) { child.remove(); continue; }
      clean(child);
    }
  }
  clean(template.content); return template.innerHTML;
}
function schedulePageSave(element, pageNumber) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll(".editor-image-wrap.is-selected").forEach(e=>e.classList.remove("is-selected"));
  const content = clone.innerHTML;
  state.pageCache[pageNumber] = content;
  state.dirtyPages[pageNumber] = content;
  clearTimeout(state.pageSaveTimers[pageNumber]);
  state.pageSaveTimers[pageNumber] = setTimeout(() => flushPage(pageNumber), 900);
}
async function flushPage(pageNumber) {
  clearTimeout(state.pageSaveTimers[pageNumber]);
  const notebookId = state.currentNotebook?.id;
  if (!notebookId) return false;
  const previous = state.pageSaveQueues[pageNumber] || Promise.resolve(true);
  const job = previous.then(async () => {
    const content = state.dirtyPages[pageNumber];
    if (content === undefined) return true;
    try {
      await api(`/api/notebooks/${notebookId}/pages/${pageNumber}`, { method:"PUT", body:JSON.stringify({content}) });
      if (state.dirtyPages[pageNumber] === content) delete state.dirtyPages[pageNumber];
      return true;
    } catch (error) { showToast("Enregistrement impossible : " + error.message); return false; }
  });
  state.pageSaveQueues[pageNumber] = job;
  return job;
}
async function flushAllPages() {
  const numbers = Object.keys(state.dirtyPages).map(Number);
  const results = await Promise.all(numbers.map(flushPage));
  return results.every(Boolean) && Object.keys(state.dirtyPages).length === 0;
}
async function goToSpread(next) {
  if (state.navigating) return;
  next = Math.max(1, Math.min(119, next));
  if (next === state.currentPage) return;
  state.navigating = true;
  try {
    if (!(await flushAllPages())) { showToast("Navigation annulée : enregistrez d’abord les modifications."); return; }
    const previousPage = state.currentPage;
    state.currentPage = next;
    if (!(await loadSpread())) state.currentPage = previousPage;
  } finally { state.navigating = false; }
}
function moveSpread(delta) { return goToSpread(state.currentPage + delta * 2); }
window.addEventListener("beforeunload", event => { if (Object.keys(state.dirtyPages).length) { event.preventDefault(); event.returnValue = ""; } });

async function loadBookmarks() {
  const host = $("#reader-bookmarks");
  try {
    const result = await api(`/api/notebooks/${state.currentNotebook.id}/bookmarks`);
    host.innerHTML = "";
    const bookmarks = result.bookmarks || [];
    const tabs = $("#book-tabs");
    if (tabs) {
      tabs.innerHTML = "";
      bookmarks.slice(0, 8).forEach(item => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "book-tab";
        tab.style.setProperty("--tab-color", item.color || "#d9a441");
        tab.title = `p. ${item.page_number} – ${item.label || "Marque-page"}`;
        tab.setAttribute("aria-label", tab.title);
        tab.addEventListener("click", () => {
          const page = Math.max(1, Math.min(120, Number(item.page_number) || 1));
          goToSpread(page % 2 ? page : Math.max(1, page - 1));
        });
        tabs.appendChild(tab);
      });
      tabs.hidden = bookmarks.length === 0;
      tabs.classList.toggle("has-bookmarks", bookmarks.length > 0);
    }
    bookmarks.forEach(item => {
      const button = document.createElement("button");
      button.className = "bookmark-entry";
      button.innerHTML = `<i style="background:${item.color}"></i><span>p. ${item.page_number} – ${escapeHtml(item.label || "Sans titre")}</span>`;
      button.addEventListener("click", () => goToSpread(item.page_number % 2 ? item.page_number : item.page_number - 1));
      host.appendChild(button);
    });
    if (!bookmarks.length) host.innerHTML = '<p class="muted">Aucun marque-page pour le moment.</p>';
  } catch (e) { host.textContent = "Marque-pages indisponibles."; }
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

["left-page-content", "right-page-content"].forEach((id, index) => {
  const el = $("#" + id);
  el.dataset.lastValidHtml = el.innerHTML;
  const rememberSelection = () => {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (el.contains(range.commonAncestorContainer)) savedEditorRange = range.cloneRange();
  };
  el.addEventListener("keyup", rememberSelection);
  el.addEventListener("touchend", rememberSelection);
  el.addEventListener("mouseup", rememberSelection);
  el.addEventListener("focus", rememberSelection);
  el.addEventListener("input", event => {
    rememberSelection();
    // Si une ancienne page déborde déjà, on doit toujours pouvoir effacer son contenu.
    const overflowing = el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
    const removing = (event.inputType || "").startsWith("delete") || event.inputType === "historyUndo";
    if (overflowing && !removing) {
      el.innerHTML = el.dataset.lastValidHtml || "";
      placeCaretAtEnd(el);
      showToast("Cette page est pleine. Efface du contenu ou passe à la page suivante.");
      return;
    }
    el.dataset.lastValidHtml = el.innerHTML;
    schedulePageSave(el, state.currentPage + index);
  });
  el.addEventListener("paste", event => {
    event.preventDefault();
    document.execCommand("insertText", false, (event.clipboardData || window.clipboardData).getData("text/plain"));
  });
});
function placeCaretAtEnd(element) {
  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
$("#reader-prev").addEventListener("click", () => moveSpread(-1));
$("#reader-prev-side").addEventListener("click", () => moveSpread(-1));
$("#reader-next").addEventListener("click", () => moveSpread(1));
$("#reader-next-side").addEventListener("click", () => moveSpread(1));
$("#reader-first").addEventListener("click", () => goToSpread(1));
$("#reader-last").addEventListener("click", () => goToSpread(119));
$("#reader-save").addEventListener("click", async () => { if (await flushAllPages()) showToast("Carnet enregistré."); });
$("#reader-cloud").addEventListener("click", async () => { if(window.archivesDesktop) { if(await flushAllPages()) {await openLibrarySection("notebooks");showToast("Utilise les commandes Google Drive dans la bibliothèque.");} } else $("#reader-save").click(); });
$("#reader-close").addEventListener("click", () => openLibrarySection("notebooks"));
$("#reader-home").addEventListener("click", e => { e.preventDefault(); $("#reader-close").click(); });
$("#reader-logout").addEventListener("click", logoutAccount);
function setInspectorVisible(visible) { $("#reader-view").classList.toggle("inspector-hidden", !visible); $("#reader-inspector-toggle").setAttribute("aria-expanded", String(visible)); requestAnimationFrame(applyBookZoom); }
$("#reader-inspector-toggle").addEventListener("click", () => setInspectorVisible($("#reader-view").classList.contains("inspector-hidden")));
$("#inspector-hide").addEventListener("click", () => setInspectorVisible(false));
$("#reader-edit").addEventListener("click", async () => { if (!(await flushAllPages())) return; try { const r = await api("/api/notebooks"); const n = (r.notebooks||[]).find(x=>x.id===state.currentNotebook.id); if(n){ await loadNotebooks(); state.currentNotebook = null; showView("library"); openEditDialog(n); } } catch(e) { showToast(e.message); } });
$("#reader-delete").addEventListener("click", async () => { if(!confirm("Placer ce carnet dans la corbeille ? Vous pourrez le restaurer.")) return; if (!(await flushAllPages())) return; try { await api(`/api/notebooks/${state.currentNotebook.id}`, {method:"DELETE"}); Object.values(state.pageSaveTimers).forEach(clearTimeout); state.dirtyPages = {}; state.currentNotebook = null; state.librarySection = "notebooks"; await loadNotebooks(); showView("library"); showToast("Carnet placé dans la corbeille."); } catch(e) { showToast(e.message); } });
$("#reader-add-bookmark").addEventListener("click", async () => { const label = prompt("Nom de ce marque-page :", "Page importante"); if(label===null) return; try { await api(`/api/notebooks/${state.currentNotebook.id}/bookmarks`, {method:"POST", body:JSON.stringify({pageNumber:state.currentPage,label,color:"#d9a441"})}); await loadBookmarks(); showToast("Marque-page ajouté."); } catch(e){showToast(e.message);} });
function restoreEditorSelection() {
  const selection = window.getSelection();
  if (!savedEditorRange || !selection) return false;
  try { selection.removeAllRanges(); selection.addRange(savedEditorRange); return true; }
  catch (_) { return false; }
}
function rememberActiveRange() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (["left-page-content", "right-page-content"].some(id => $("#"+id).contains(range.commonAncestorContainer))) savedEditorRange = range.cloneRange();
}
function saveSelectedEditor() {
  const node = savedEditorRange?.commonAncestorContainer;
  const el = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.(".page-content");
  if (el) schedulePageSave(el, el.id === "left-page-content" ? state.currentPage : state.currentPage + 1);
}
function runEditorCommand(command, value = null) {
  restoreEditorSelection();
  document.execCommand(command, false, value);
  rememberActiveRange();
  saveSelectedEditor();
}
$(".reader-toolbar").addEventListener("mousedown", e => {
  if (e.target.closest("button")) e.preventDefault();
});
$(".reader-toolbar").addEventListener("click", e => { const b=e.target.closest("button[data-cmd]"); if(!b) return; if (b.dataset.cmd === "createLink") { const url = prompt("Adresse du lien (https://…) :"); if (!url) return; if (!/^https?:\/\//i.test(url)) { showToast("Utilisez une adresse http ou https."); return; } runEditorCommand("createLink",url); } else runEditorCommand(b.dataset.cmd); });
$("#reader-font").addEventListener("change", e => runEditorCommand("fontName",e.target.value));
$("#reader-size").addEventListener("change", e => {
  restoreEditorSelection();
  const points = Math.max(1, Math.min(96, Number(e.target.value) || 11)); e.target.value = points;
  const px = Math.round(points * 96 / 72);
  document.execCommand("fontSize",false,"7");
  document.querySelectorAll('.page-content font[size="7"]').forEach(node => { node.removeAttribute("size"); node.style.fontSize = px + "px"; });
  rememberActiveRange();
  saveSelectedEditor();
});
$("#reader-block-style").addEventListener("change", e => {
  const tag = e.target.value;
  if (!restoreEditorSelection()) return;
  const selection = window.getSelection();
  const quoteOf = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.("blockquote");
  const quote = selection?.rangeCount ? quoteOf(selection.anchorNode) : null;
  const endQuote = selection?.rangeCount ? quoteOf(selection.focusNode) : null;
  const leavingQuote = tag !== "blockquote" && quote && quote === endQuote && quote.closest(".page-content");
  // Chromium peut copier le style de la citation sur ses descendants lors de
  // l'outdent. Mémoriser les styles propres au contenu avant de le déplacer.
  if (leavingQuote) {
    const editor = quote.closest(".page-content");
    const citationStyle = getComputedStyle(quote);
    const inherited = {"font-family":citationStyle.fontFamily, "font-size":citationStyle.fontSize, "font-style":citationStyle.fontStyle};
    const originals = new Map();
    let index = 0;
    for (const element of quote.querySelectorAll("*")) {
      const id = String(index++);
      originals.set(id, element.getAttribute("style"));
      element.setAttribute("data-archives-restore-style", id);
    }
    document.execCommand("outdent", false, null);
    const anchor = selection?.anchorNode;
    const resultBlock = (anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement)?.closest?.("p,h1,h2,h3,div,li");
    if (resultBlock && editor.contains(resultBlock)) {
      for (const element of resultBlock.querySelectorAll("span:not([data-archives-restore-style])")) {
        for (const [property,value] of Object.entries(inherited)) {
          if (element.style.getPropertyValue(property) === value) element.style.removeProperty(property);
        }
        if (!element.getAttribute("style")) element.removeAttribute("style");
      }
    }
    for (const element of editor.querySelectorAll("[data-archives-restore-style]")) {
      const style = originals.get(element.getAttribute("data-archives-restore-style"));
      if (style === null || style === undefined) element.removeAttribute("style"); else element.setAttribute("style", style);
      element.removeAttribute("data-archives-restore-style");
    }
  }
  document.execCommand("formatBlock", false, `<${tag}>`);
  if (selection?.rangeCount) {
    let node = selection.anchorNode;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const block = node?.closest?.("p,h1,h2,h3,blockquote,div,li");
    if (block && block.closest(".page-content") && !block.classList.contains("page-content")) {
      // formatBlock peut conserver les attributs de l'ancienne citation.
      if (leavingQuote) { block.style.removeProperty("border-left"); block.style.removeProperty("padding-left"); block.style.fontStyle = "normal"; }
      if (tag === "p") { block.style.fontFamily = "Garamond, Georgia, serif"; block.style.fontSize = "14.67px"; block.style.fontWeight = "400"; block.style.fontStyle = "normal"; }
      if (tag === "h1") { block.style.fontFamily = "Georgia, serif"; block.style.fontSize = "30px"; block.style.fontWeight = "700"; block.style.margin = "0 0 .55em"; }
      if (tag === "h2") { block.style.fontFamily = "Garamond, Georgia, serif"; block.style.fontSize = "22px"; block.style.fontWeight = "700"; block.style.margin = "0 0 .5em"; }
      if (tag === "h3") { block.style.fontFamily = "Georgia, serif"; block.style.fontSize = "18px"; block.style.fontWeight = "700"; }
      if (tag === "blockquote") { block.style.fontFamily = "Georgia, serif"; block.style.fontSize = "17px"; block.style.fontStyle = "italic"; block.style.borderLeft = "2px solid #b38a5c"; block.style.paddingLeft = "12px"; }
    }
  }
  rememberActiveRange();
  saveSelectedEditor();
});
$("#reader-text-color").addEventListener("input", e => { runEditorCommand("foreColor",e.target.value); });
$("#reader-highlight").addEventListener("input", e => { restoreEditorSelection(); document.execCommand("hiliteColor",false,e.target.value); rememberActiveRange(); saveSelectedEditor(); });
let pendingImageContext = null;
$("#reader-image").addEventListener("click", () => {
  rememberActiveRange();
  const range = savedEditorRange?.cloneRange() || null;
  const node = range?.commonAncestorContainer;
  const editor = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.(".page-content");
  pendingImageContext = { notebookId: state.currentNotebook?.id, page: state.currentPage, editorId: editor?.id || "left-page-content", range };
  $("#reader-image-file").click();
});
$("#reader-image-file").addEventListener("change", async e => {
  const file=e.target.files[0], context=pendingImageContext; if(!file || !context) return;
  try {
    const dataUrl = await compressEditorImage(file);
    if (state.currentNotebook?.id !== context.notebookId || state.currentPage !== context.page) throw new Error("La page a changé. Sélectionnez à nouveau l’endroit puis l’image.");
    const wrapper = document.createElement("span");
    wrapper.className = "editor-image-wrap";
    wrapper.contentEditable = "false";
    wrapper.style.width = "220px";
    const img = document.createElement("img"); img.src = dataUrl; img.alt = file.name; img.draggable = false;
    wrapper.appendChild(img);
    addImageHandles(wrapper);
    const target = $("#"+context.editorId), range = context.range;
    if (range && target.contains(range.commonAncestorContainer)) { range.deleteContents(); range.insertNode(wrapper); range.setStartAfter(wrapper); range.collapse(true); const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    else target.appendChild(wrapper);
    const page = wrapper.closest("#right-page-content") ? state.currentPage+1 : state.currentPage;
    const editor = wrapper.closest(".page-content");
    if (!editor || editor.innerHTML.length > 900000 || editor.scrollHeight > editor.clientHeight + 2) { wrapper.remove(); throw new Error("L’image ne tient pas dans cette page ou dépasse sa limite de stockage."); }
    selectEditorImage(wrapper); editor.dataset.lastValidHtml = editor.innerHTML; schedulePageSave(editor,page);
    showToast("Image ajoutée : déplacez-la ou tirez les carrés pour la redimensionner.");
  } catch(err) { showToast(err.message || "Impossible de lire cette image. Essayez un fichier JPG, PNG ou WebP."); }
  e.target.value=""; pendingImageContext = null;
});
async function compressEditorImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Choisis un fichier image.");
  const url=URL.createObjectURL(file);
  try {
    const img=new Image(); img.src=url;
    try { await img.decode(); } catch (_) { throw new Error("Image illisible dans ce navigateur. Essayez un fichier JPG, PNG ou WebP."); }
    let scale=Math.min(1,900/Math.max(img.width,img.height));
    const canvas=document.createElement("canvas"); let data = "";
    for (let attempt=0; attempt<8; attempt++) {
      canvas.width=Math.max(1,Math.round(img.width*scale)); canvas.height=Math.max(1,Math.round(img.height*scale));
      canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
      data=canvas.toDataURL("image/webp", .68);
      if (!data.startsWith("data:image/webp")) data=canvas.toDataURL("image/jpeg", .68);
      if (data.length <= 120000) break;
      scale *= .75;
    }
    if(data.length>120000) throw new Error("Image trop volumineuse après compression.");
    return data;
  } finally { URL.revokeObjectURL(url); }
}
// Les poignées restent dans le document, mais l’état de sélection ne sera pas enregistré.
let selectedEditorImage = null;
function addImageHandles(wrap) {
  wrap.querySelectorAll(".image-resize-handle").forEach(h=>h.remove());
  wrap.setAttribute("tabindex","0");
  for (const dir of ["nw","n","ne","e","se","s","sw","w"]) {
    const h=document.createElement("span"); h.className="image-resize-handle"; h.dataset.direction=dir; h.title="Redimensionner"; wrap.appendChild(h);
  }
}
function hydrateImages(editor) { editor.querySelectorAll(".editor-image-wrap").forEach(addImageHandles); }
function selectEditorImage(wrap) {
  if (selectedEditorImage) selectedEditorImage.classList.remove("is-selected");
  selectedEditorImage=wrap;
  if (wrap) wrap.classList.add("is-selected");
  $("#image-tools").classList.toggle("hidden",!wrap);
}
function saveImageEditor(wrap) {
  const editor=wrap?.closest(".page-content");
  if (editor) { editor.dataset.lastValidHtml=editor.innerHTML; schedulePageSave(editor,editor.id==="left-page-content"?state.currentPage:state.currentPage+1); }
}
$("#image-delete").addEventListener("click",()=>{
  const wrap=selectedEditorImage, editor=wrap?.closest(".page-content"); if(!editor)return;
  selectEditorImage(null); wrap.remove(); editor.dataset.lastValidHtml=editor.innerHTML;
  schedulePageSave(editor,editor.id==="left-page-content"?state.currentPage:state.currentPage+1);
});
document.querySelectorAll("[data-image-align]").forEach(button=>button.addEventListener("click",()=>{
  const wrap=selectedEditorImage; if(!wrap)return;
  const alignment=button.dataset.imageAlign; wrap.style.display="block"; wrap.style.position="relative"; wrap.style.left="0px"; wrap.style.top="0px";
  wrap.style.marginLeft=alignment==="right"||alignment==="center"?"auto":"0px";
  wrap.style.marginRight=alignment==="left"||alignment==="center"?"auto":"0px";
  saveImageEditor(wrap);
}));
document.addEventListener("keydown",e=>{if(selectedEditorImage && (e.key==="Delete" || e.key==="Backspace") && !e.target.closest("input,textarea,select")){e.preventDefault();$("#image-delete").click();}});
document.addEventListener("pointerdown",e=>{
  const wrap=e.target.closest(".editor-image-wrap");
  if(!wrap) { if (!e.target.closest("#image-tools")) selectEditorImage(null); return; }
  const editor=wrap.closest(".page-content"); if(!editor)return;
  e.preventDefault(); selectEditorImage(wrap);
  const scale=$("#physical-book").getBoundingClientRect().width/912 || 1;
  const startX=e.clientX,startY=e.clientY, box=wrap.getBoundingClientRect(), bounds=editor.getBoundingClientRect();
  const left=parseFloat(wrap.style.left)||0, top=parseFloat(wrap.style.top)||0;
  const startW=wrap.offsetWidth, startH=wrap.offsetHeight;
  const handle=e.target.closest(".image-resize-handle"),dir=handle?.dataset.direction;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const move=ev=>{
    const dx=(ev.clientX-startX)/scale, dy=(ev.clientY-startY)/scale;
    wrap.style.position="relative";
    if (!dir) {
      wrap.style.left=clamp(left+dx,left+(bounds.left-box.left)/scale,left+(bounds.right-box.right)/scale)+"px";
      wrap.style.top=clamp(top+dy,top+(bounds.top-box.top)/scale,top+(bounds.bottom-box.bottom)/scale)+"px";
    } else {
      let change=dir.includes("w")?-dx:dir.includes("e")?dx:(dir.includes("n")?-dy:dy)*startW/startH;
      const maxHorizontal=startW+(dir.includes("w")?(box.left-bounds.left):(bounds.right-box.right))/scale;
      const maxHeight=(dir.includes("n")?(box.bottom-bounds.top):(bounds.bottom-box.top))/scale;
      const maxW= Math.max(40, startW, Math.min(editor.clientWidth, maxHorizontal, maxHeight*startW/startH));
      const width=clamp(startW+change,40,maxW), height=startH*width/startW;
      wrap.style.width=width+"px";
      if(dir.includes("w")) wrap.style.left=(left+startW-width)+"px";
      if(dir.includes("n")) wrap.style.top=(top+startH-height)+"px";
    }
  };
  const up=()=>{document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);document.removeEventListener("pointercancel",up);saveImageEditor(wrap);};
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",up,{once:true});document.addEventListener("pointercancel",up,{once:true});
});
$("#reader-zoom-in").addEventListener("click", () => setZoom(10));
$("#reader-zoom-out").addEventListener("click", () => setZoom(-10));
function applyBookZoom(){
  const book=$("#physical-book"), viewport=$("#book-viewport"), canvas=$("#book-canvas");
  if(!book || !viewport || !canvas || !viewport.clientWidth || !viewport.clientHeight) return;
  const fit = Math.min(Math.max(1,viewport.clientWidth - 32) / 912, Math.max(1,viewport.clientHeight - 24) / 654);
  const scale=fit * state.zoom / 100;
  canvas.style.width=(912*scale)+"px"; canvas.style.height=(654*scale)+"px";
  book.style.transform=`scale(${scale})`;
  viewport.classList.toggle("is-zoomed",state.zoom>100);
}
function setZoom(delta){
  state.zoom=Math.max(70,Math.min(160,state.zoom+delta));
  $("#reader-zoom-label").textContent=state.zoom+" %";
  applyBookZoom();
}

$("#reader-fullscreen").addEventListener("click", () => { if(!document.fullscreenElement) $("#reader-view").requestFullscreen?.(); else document.exitFullscreen?.(); });
$("#reader-download").addEventListener("click", () => { const text=[$("#left-page-content").innerText,$("#right-page-content").innerText].join("\n\n"); const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"})); a.download=(state.currentNotebook?.title||"carnet")+".txt"; a.click(); URL.revokeObjectURL(a.href); });

new ResizeObserver(() => { if (state.currentNotebook) applyBookZoom(); }).observe($("#book-viewport"));
let readerResizeTimer;
window.addEventListener("resize",()=>{
  if(!state.currentNotebook) return;
  clearTimeout(readerResizeTimer);
  readerResizeTimer=setTimeout(()=>applyBookZoom(),80);
});

// Vérification facultative : aucun compte ni carnet n'est transmis au site.
if (window.archivesDesktop?.update) {
  let dismissedVersion = null;
  const notice = $("#update-notice");
  async function checkUpdates() {
    try {
      const result = await window.archivesDesktop.update("check");
      if (result.available && result.version !== dismissedVersion) {
        $("#update-version").textContent = `Version ${result.version} · téléchargement sur le site officiel`;
        notice.classList.remove("hidden");
      }
    } catch (_) { /* Une absence de réseau ne bloque pas l'application. */ }
  }
  $("#update-open").addEventListener("click", async () => {
    try { const result=await window.archivesDesktop.update("open"); if(!result?.ok) showToast("Impossible d’ouvrir le site."); }
    catch (_) { showToast("Impossible d’ouvrir le site."); }
  });
  $("#update-dismiss").addEventListener("click", () => {
    dismissedVersion = $("#update-version").textContent.match(/^Version ([0-9.]+)/)?.[1] || null;
    notice.classList.add("hidden");
  });
  checkUpdates();
  window.setInterval(checkUpdates, 6 * 60 * 60 * 1000);
}
