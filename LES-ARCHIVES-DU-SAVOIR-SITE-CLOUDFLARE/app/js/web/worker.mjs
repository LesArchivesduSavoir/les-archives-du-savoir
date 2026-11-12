const SESSION_COOKIE = "archives_session";
const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 210000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("X-Archives-Session") || "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function derivePassword(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

function cookieHeader(token, request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookie(request) {
  return cookieHeader("", request, 0);
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 1200000) throw new Error("Requête trop volumineuse.");
  return await request.json();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

async function requireSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

async function getCurrentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(`
    SELECT users.id, users.email, users.display_name
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first();

  return row || null;
}

async function createSession(userId, request, env) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString();

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, userId, tokenHash, expires, now.toISOString()).run();

  return cookieHeader(token, request, SESSION_DAYS * 86400);
}

// Utilisé uniquement après validation Firebase par le processus local ou le point de connexion.
export async function createVerifiedFirebaseSession({session, verified, request, env}) {
  if (!verified?.emailVerified) return json({error:"Vérifie ton adresse avec le lien reçu par e-mail avant de te connecter."}, 403);
  if (!session?.userId || verified.userId !== session.userId || !verified.email) return json({error:"Compte Firebase invalide."}, 401);
  const name = String(verified.displayName || verified.email.split('@')[0]).slice(0,60);
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name`)
      .bind(verified.userId,verified.email,name,'firebase-auth-only','firebase-auth-only',now).run();
  } catch { return json({error:"Impossible d'ouvrir ce compte localement."}, 500); }
  const cookie = await createSession(verified.userId, request, env);
  return json({user:{id:verified.userId,email:verified.email,displayName:name}},200,{"X-Archives-Set-Cookie":cookie});
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method !== "GET" && !(await requireSameOrigin(request))) {
    return json({ error: "Origine de requête invalide." }, 403);
  }

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, service: "Les Archives du Savoir" });
  }

  if (path === "/api/register" && method === "POST") {
    let body;
    try { body = await readJson(request); } catch { return json({ error: "Données invalides." }, 400); }

    const displayName = String(body.displayName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (displayName.length < 2 || displayName.length > 60) {
      return json({ error: "Le nom doit contenir entre 2 et 60 caractères." }, 400);
    }
    if (!validEmail(email)) return json({ error: "Adresse e-mail invalide." }, 400);
    if (password.length < 10 || password.length > 200) {
      return json({ error: "Le mot de passe doit contenir au moins 10 caractères." }, 400);
    }

    // Le mode bureau est explicite : les anciennes versions Workers conservent
    // leur authentification et leurs données. Aucun mot de passe Firebase n'est stocké.
    if (env.FIREBASE_AUTH) {
      let account;
      try { account = await env.FIREBASE_AUTH.register(email, password); }
      catch (error) { return json({error:error.message}, 400); }
      let profileSaved = true, mailSent = true;
      try { await env.FIREBASE_AUTH.setDisplayName(account.idToken, displayName); } catch { profileSaved = false; }
      try { await env.FIREBASE_AUTH.sendVerificationEmail(account.idToken); } catch { mailSent = false; }
      return json({verificationRequired:true, emailSent:mailSent, profileSaved}, 201);
    }

    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return json({ error: "Un compte existe déjà avec cette adresse e-mail." }, 409);

    const userId = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordHash = await derivePassword(password, salt);
    const now = new Date().toISOString();

    try {
      await env.DB.prepare(`
        INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(userId, email, displayName, passwordHash, bytesToBase64Url(salt), now).run();
    } catch {
      return json({ error: "Impossible de créer le compte. Réessaie." }, 500);
    }

    const cookie = await createSession(userId, request, env);
    return json({ user: { id: userId, email, displayName } }, 201, { "X-Archives-Set-Cookie": cookie });
  }

  if (path === "/api/login" && method === "POST") {
    let body;
    try { body = await readJson(request); } catch { return json({ error: "Données invalides." }, 400); }

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!validEmail(email) || !password) return json({ error: "Adresse e-mail ou mot de passe incorrect." }, 401);

    if (env.FIREBASE_AUTH) {
      let session, verified;
      try {
        session = await env.FIREBASE_AUTH.signIn(email, password);
        verified = await env.FIREBASE_AUTH.getUser(session.idToken);
      } catch (error) { return json({error:error.message}, 401); }
      return createVerifiedFirebaseSession({session,verified,request,env});
    }

    const user = await env.DB.prepare(`
      SELECT id, email, display_name, password_hash, password_salt
      FROM users WHERE email = ? LIMIT 1
    `).bind(email).first();

    if (!user) return json({ error: "Adresse e-mail ou mot de passe incorrect." }, 401);

    const calculated = await derivePassword(password, base64UrlToBytes(user.password_salt));
    if (calculated !== user.password_hash) {
      return json({ error: "Adresse e-mail ou mot de passe incorrect." }, 401);
    }

    const cookie = await createSession(user.id, request, env);
    return json({
      user: { id: user.id, email: user.email, displayName: user.display_name }
    }, 200, { "X-Archives-Set-Cookie": cookie });
  }

  if (path === "/api/resend-verification" && method === "POST" && env.FIREBASE_AUTH) {
    let body; try { body = await readJson(request); } catch { return json({error:"Données invalides."},400); }
    const email=String(body.email||"").trim().toLowerCase(), password=String(body.password||"");
    if(!validEmail(email)||!password) return json({error:"Indique ton adresse e-mail et ton mot de passe."},400);
    try {
      const session=await env.FIREBASE_AUTH.signIn(email,password);
      const user=await env.FIREBASE_AUTH.getUser(session.idToken);
      if(user.emailVerified) return json({alreadyVerified:true});
      await env.FIREBASE_AUTH.sendVerificationEmail(session.idToken);
      return json({ok:true});
    } catch(error) {return json({error:error.message||"Impossible d’envoyer l’e-mail."},400);}
  }

  if (path === "/api/logout" && method === "POST") {
    const token = getCookie(request, SESSION_COOKIE);
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(await sha256(token)).run();
    }
    return json({ ok: true }, 200, { "X-Archives-Set-Cookie": clearCookie(request) });
  }

  if (path === "/api/me" && method === "GET") {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ user: null });
    return json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
  }

  if (path === "/api/notebooks" && method === "GET") {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: "Connexion nécessaire." }, 401);

    const trash = url.searchParams.get("scope") === "trash";
    const result = await env.DB.prepare(`
      SELECT n.id, n.title, n.description, n.cover_color, n.cover_image_data, n.page_count, n.created_at, n.updated_at,
             COALESCE(l.is_favorite, 0) AS is_favorite, l.last_opened_at, l.deleted_at
      FROM notebooks n LEFT JOIN notebook_library_state l ON l.notebook_id = n.id AND l.user_id = n.user_id
      WHERE n.user_id = ? AND ${trash ? "l.deleted_at IS NOT NULL" : "l.deleted_at IS NULL"}
      ORDER BY ${trash ? "l.deleted_at DESC" : "n.updated_at DESC"}
    `).bind(user.id).all();

    return json({ notebooks: result.results || [] });
  }

  if (path === "/api/notebooks" && method === "POST") {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: "Connexion nécessaire." }, 401);

    let body;
    try { body = await readJson(request); } catch { return json({ error: "Données invalides." }, 400); }

    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const coverColor = String(body.coverColor || "#6f263d");
    const coverImageData = body.coverImageData ? String(body.coverImageData) : null;

    const allowedColors = ["#6f263d", "#244b3c", "#243b63", "#70472f", "#292929", "#51406b"];
    if (title.length < 1 || title.length > 80) return json({ error: "Le titre doit contenir entre 1 et 80 caractères." }, 400);
    if (description.length > 500) return json({ error: "La description est trop longue." }, 400);
    if (!/^#[0-9a-fA-F]{6}$/.test(coverColor)) return json({ error: "Code couleur invalide." }, 400);
    if (coverImageData && (!/^data:image\/(jpeg|png|webp);base64,/.test(coverImageData) || coverImageData.length > 950000)) {
      return json({ error: "Image invalide ou trop volumineuse. Choisis une image plus légère." }, 400);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO notebooks (id, user_id, title, description, cover_color, cover_image_data, page_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).bind(id, user.id, title, description, coverColor, coverImageData, now, now).run();

    return json({
      notebook: { id, title, description, cover_color: coverColor, cover_image_data: coverImageData, page_count: 0, created_at: now, updated_at: now }
    }, 201);
  }


  if (path === "/api/bookmarks" && method === "GET") {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: "Connexion nécessaire." }, 401);
    const rows = await env.DB.prepare(`SELECT b.id, b.notebook_id, b.page_number, b.label, b.color, b.created_at,
      n.title AS notebook_title
      FROM bookmarks b JOIN notebooks n ON n.id = b.notebook_id
      LEFT JOIN notebook_library_state l ON l.notebook_id = n.id AND l.user_id = n.user_id
      WHERE n.user_id = ? AND l.deleted_at IS NULL ORDER BY b.created_at DESC`).bind(user.id).all();
    return json({ bookmarks: rows.results || [] });
  }

  const libraryRoute = path.match(/^\/api\/notebooks\/([a-f0-9-]+)\/(favorite|opened|restore|permanent)$/i);
  if (libraryRoute) {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: "Connexion nécessaire." }, 401);
    const id = libraryRoute[1], action = libraryRoute[2].toLowerCase();
    const owned = await env.DB.prepare(`SELECT n.id, l.deleted_at FROM notebooks n LEFT JOIN notebook_library_state l ON l.notebook_id = n.id AND l.user_id = n.user_id WHERE n.id = ? AND n.user_id = ?`).bind(id,user.id).first();
    if (!owned) return json({error:"Carnet introuvable."},404);
    if (action === "permanent" && method === "DELETE") {
      if (!owned.deleted_at) return json({error:"Placez d’abord le carnet dans la corbeille."},400);
      await env.DB.prepare("DELETE FROM notebooks WHERE id = ? AND user_id = ?").bind(id,user.id).run();
      return json({ok:true});
    }
    if (action === "restore" && method === "POST") {
      await env.DB.prepare("UPDATE notebook_library_state SET deleted_at = NULL WHERE notebook_id = ? AND user_id = ?").bind(id,user.id).run();
      return json({ok:true});
    }
    if (owned.deleted_at) return json({error:"Ce carnet est dans la corbeille."},404);
    if (action === "opened" && method === "POST") {
      await env.DB.prepare(`INSERT INTO notebook_library_state (notebook_id,user_id,last_opened_at) VALUES (?,?,?) ON CONFLICT(notebook_id) DO UPDATE SET last_opened_at=excluded.last_opened_at WHERE user_id=excluded.user_id`).bind(id,user.id,new Date().toISOString()).run();
      return json({ok:true});
    }
    if (action === "favorite" && method === "PUT") {
      let body; try { body = await readJson(request); } catch { return json({error:"Données invalides."},400); }
      if (typeof body.favorite !== "boolean") return json({error:"Valeur de favori invalide."},400);
      await env.DB.prepare(`INSERT INTO notebook_library_state (notebook_id,user_id,is_favorite) VALUES (?,?,?) ON CONFLICT(notebook_id) DO UPDATE SET is_favorite=excluded.is_favorite WHERE user_id=excluded.user_id`).bind(id,user.id,body.favorite?1:0).run();
      return json({ok:true});
    }
  }

  const bookmarkItem = path.match(/^\/api\/notebooks\/([a-f0-9-]+)\/bookmarks\/([a-f0-9-]+)$/i);
  if (bookmarkItem && method === "DELETE") {
    const user = await getCurrentUser(request, env);
    if (!user) return json({error:"Connexion nécessaire."},401);
    const owned = await env.DB.prepare("SELECT id FROM notebooks WHERE id = ? AND user_id = ?").bind(bookmarkItem[1],user.id).first();
    if (!owned) return json({error:"Carnet introuvable."},404);
    await env.DB.prepare("DELETE FROM bookmarks WHERE id = ? AND notebook_id = ?").bind(bookmarkItem[2],bookmarkItem[1]).run();
    return json({ok:true});
  }

  const pageRoute = path.match(/^\/api\/notebooks\/([a-f0-9-]+)\/pages\/(\d+)$/i);
  const bookmarkRoute = path.match(/^\/api\/notebooks\/([a-f0-9-]+)\/bookmarks$/i);
  if (pageRoute || bookmarkRoute) {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: "Connexion nécessaire." }, 401);
    const notebookId = (pageRoute || bookmarkRoute)[1];
    const owned = await env.DB.prepare("SELECT id FROM notebooks WHERE id = ? AND user_id = ?").bind(notebookId, user.id).first();
    if (!owned) return json({ error: "Carnet introuvable." }, 404);
    if (pageRoute) {
      const pageNumber = Math.max(1, Math.min(120, Number(pageRoute[2])));
      if (method === "GET") {
        const row = await env.DB.prepare("SELECT content_json FROM notebook_pages WHERE notebook_id = ? AND page_number = ?").bind(notebookId, pageNumber).first();
        let content = ""; try { content = row ? JSON.parse(row.content_json).html || "" : ""; } catch {}
        return json({ pageNumber, content });
      }
      if (method === "PUT") {
        let body; try { body = await readJson(request); } catch { return json({ error: "Données invalides." }, 400); }
        const content = String(body.content || "");
        if (content.length > 900000) return json({ error: "Cette page est trop volumineuse." }, 400);
        const now = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO notebook_pages (id, notebook_id, page_number, content_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(notebook_id, page_number) DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at`).bind(crypto.randomUUID(), notebookId, pageNumber, JSON.stringify({ html: content }), now).run();
        await env.DB.prepare("UPDATE notebooks SET updated_at = ?, page_count = MAX(page_count, ?) WHERE id = ?").bind(now, pageNumber, notebookId).run();
        return json({ ok: true });
      }
    }
    if (bookmarkRoute) {
      if (method === "GET") { const rows = await env.DB.prepare("SELECT id, page_number, label, color, created_at FROM bookmarks WHERE notebook_id = ? ORDER BY page_number").bind(notebookId).all(); return json({ bookmarks: rows.results || [] }); }
      if (method === "POST") { let body; try { body = await readJson(request); } catch { return json({ error: "Données invalides." }, 400); } const pageNumber = Math.max(1, Math.min(120, Number(body.pageNumber)||1)); const label = String(body.label||"").slice(0,80); const color = /^#[0-9a-fA-F]{6}$/.test(body.color||"") ? body.color : "#d9a441"; const id=crypto.randomUUID(); await env.DB.prepare("INSERT INTO bookmarks (id, notebook_id, page_number, label, color, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id,notebookId,pageNumber,label,color,new Date().toISOString()).run(); return json({ok:true,id},201); }
    }
  }

  const notebookRoute = path.match(/^\/api\/notebooks\/([a-f0-9-]+)$/i);
  if (notebookRoute && (method === "PUT" || method === "DELETE")) {
    const user = await getCurrentUser(request, env);
    if (!user) return json({ error: "Connexion nécessaire." }, 401);
    const notebookId = notebookRoute[1];

    const owned = await env.DB.prepare(
      "SELECT id FROM notebooks WHERE id = ? AND user_id = ?"
    ).bind(notebookId, user.id).first();
    if (!owned) return json({ error: "Carnet introuvable." }, 404);

    if (method === "DELETE") {
      await env.DB.prepare(`INSERT INTO notebook_library_state (notebook_id,user_id,deleted_at) VALUES (?,?,?)
        ON CONFLICT(notebook_id) DO UPDATE SET deleted_at=excluded.deleted_at WHERE user_id=excluded.user_id`)
        .bind(notebookId, user.id, new Date().toISOString()).run();
      return json({ ok: true });
    }

    let body;
    try { body = await readJson(request); } catch { return json({ error: "Données invalides." }, 400); }
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const coverColor = String(body.coverColor || "#6f263d");
    const coverImageData = body.coverImageData ? String(body.coverImageData) : null;

    if (title.length < 1 || title.length > 80) return json({ error: "Le titre doit contenir entre 1 et 80 caractères." }, 400);
    if (description.length > 500) return json({ error: "La description est trop longue." }, 400);
    if (!/^#[0-9a-fA-F]{6}$/.test(coverColor)) return json({ error: "Code couleur invalide." }, 400);
    if (coverImageData && (!/^data:image\/(jpeg|png|webp);base64,/.test(coverImageData) || coverImageData.length > 950000)) {
      return json({ error: "Image invalide ou trop volumineuse. Choisis une image plus légère." }, 400);
    }

    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE notebooks
      SET title = ?, description = ?, cover_color = ?, cover_image_data = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).bind(title, description, coverColor, coverImageData, now, notebookId, user.id).run();

    return json({ ok: true });
  }

  return json({ error: "Route introuvable." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error("API error:", error);
        if (String(error).includes("no such table: notebook_library_state")) return json({error:"Migration V2.11 nécessaire : consultez le README avant de continuer."}, 500);
        return json({ error: "Une erreur serveur est survenue." }, 500);
      }
    }
    const asset = await env.ASSETS.fetch(request);
    const secured = new Response(asset.body, asset);
    secured.headers.set("X-Content-Type-Options", "nosniff");
    secured.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    secured.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return secured;
  }
};
