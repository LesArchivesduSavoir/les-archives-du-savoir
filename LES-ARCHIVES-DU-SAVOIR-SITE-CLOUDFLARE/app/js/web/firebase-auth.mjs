/** Client Firebase Auth. Les jetons sont manipulés uniquement côté processus principal ; aucune
 * authentification ni sécurité de données ne doit reposer uniquement sur l'UI. */
export function createFirebaseAuth({apiKey, fetchImpl = fetch}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Clé de configuration Firebase absente.');
  async function call(method, payload) {
    const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(apiKey)}`;
    let response;
    try {
      response = await fetchImpl(endpoint, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error'});
    } catch { throw new Error('Connexion à Firebase impossible. Vérifiez votre accès à Internet.'); }
    if (!response.ok) {
      let code = '';
      try { code = (await response.json())?.error?.message?.split(' : ')[0] || ''; } catch {}
      const messages = {
        EMAIL_EXISTS:'Cette adresse possède déjà un compte.',
        INVALID_EMAIL:'Adresse e-mail invalide.',
        INVALID_LOGIN_CREDENTIALS:'Adresse e-mail ou mot de passe incorrect.',
        INVALID_PASSWORD:'Adresse e-mail ou mot de passe incorrect.',
        EMAIL_NOT_FOUND:'Adresse e-mail ou mot de passe incorrect.',
        USER_DISABLED:'Ce compte a été désactivé.',
        TOO_MANY_ATTEMPTS_TRY_LATER:'Trop de tentatives. Réessayez plus tard.',
        WEAK_PASSWORD:'Mot de passe trop faible.',
        OPERATION_NOT_ALLOWED:'La connexion par e-mail n’est pas activée.',
        INVALID_ID_TOKEN:'La session a expiré. Reconnectez-vous.',
        TOKEN_EXPIRED:'La session a expiré. Reconnectez-vous.'
      };
      throw new Error(messages[code] || 'Opération impossible auprès de Firebase. Réessayez.');
    }
    try { return await response.json(); } catch { throw new Error('Réponse Firebase invalide.'); }
  }
  function requireSession(result) {
    if (typeof result?.idToken !== 'string' || typeof result?.localId !== 'string') throw new Error('Réponse Firebase invalide.');
    return {idToken:result.idToken, refreshToken:result.refreshToken, userId:result.localId, email:result.email};
  }
  return {
    async register(email, password) {
      return requireSession(await call('signUp', {email, password, returnSecureToken:true}));
    },
    async signIn(email, password) {
      return requireSession(await call('signInWithPassword', {email, password, returnSecureToken:true}));
    },
    async refresh(refreshToken) {
      if(typeof refreshToken!=='string'||!refreshToken||refreshToken.length>8192) throw new Error('Session enregistrée invalide. Reconnecte-toi.');
      let response;
      try {response=await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken}),redirect:'error'});}
      catch {throw new Error('Connexion impossible. Vérifie ta connexion Internet puis reconnecte-toi.');}
      if(!response.ok) {
        let code='';try{code=(await response.json())?.error?.message||''}catch{}
        if(['TOKEN_EXPIRED','INVALID_REFRESH_TOKEN','USER_DISABLED','USER_NOT_FOUND','INVALID_GRANT'].includes(code)) throw new Error('La session a expiré ou a été révoquée. Reconnecte-toi.');
        throw new Error('Impossible de retrouver ta session. Vérifie Internet puis reconnecte-toi.');
      }
      let data;try{data=await response.json()}catch{throw new Error('Réponse Firebase invalide.');}
      if(typeof data.id_token!=='string'||!data.id_token||typeof data.user_id!=='string'||!data.user_id||typeof data.refresh_token!=='string'||!data.refresh_token)throw new Error('Réponse Firebase invalide.');
      return {idToken:data.id_token,refreshToken:data.refresh_token,userId:data.user_id};
    },
    async setDisplayName(idToken, displayName) {
      if (!idToken || typeof displayName !== 'string' || !displayName.trim()) throw new Error('Profil invalide.');
      await call('update', {idToken, displayName:displayName.trim(), returnSecureToken:false});
    },
    async sendVerificationEmail(idToken) {
      if (!idToken) throw new Error('Session absente.');
      await call('sendOobCode', {requestType:'VERIFY_EMAIL', idToken});
    },
    async getUser(idToken) {
      if (!idToken) throw new Error('Session absente.');
      const result = await call('lookup', {idToken});
      const user = result?.users?.[0];
      if (!user || typeof user.localId !== 'string' || typeof user.emailVerified !== 'boolean') throw new Error('Réponse Firebase invalide.');
      if (user.disabled === true) throw new Error('Ce compte a été désactivé.');
      return {userId:user.localId, email:user.email, emailVerified:user.emailVerified, displayName:user.displayName || ""};
    }
  };
}
