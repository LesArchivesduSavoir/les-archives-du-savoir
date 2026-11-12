// Expérimental : Google Identity Services doit être chargé par la page.
// Les jetons Drive sont conservés uniquement en mémoire. Pas d'usage en production.
const SCOPE='https://www.googleapis.com/auth/drive.file';
export function createGoogleDriveSession({clientId,google,now=()=>Date.now()}) {
 if(typeof clientId!=='string'||!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId))throw new Error('ID client Google Web invalide.');
 if(!google?.accounts?.oauth2?.initTokenClient)throw new Error('Connexion Google indisponible.');
 let token=null,expires=0,generation=0,pending=false;
 return {
  connect(){
   if(pending)return Promise.reject(new Error('Connexion déjà en cours.'));
   pending=true;const epoch=++generation;
   return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(err,result)=>{if(settled)return;settled=true;pending=false;if(err)reject(err);else resolve(result);};
    try {
     const client=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:SCOPE,
      callback:r=>{
       if(epoch!==generation)return finish(new Error('Connexion annulée.'));
       if(r.error||!r.access_token||!Number.isFinite(Number(r.expires_in))||Number(r.expires_in)<=0)return finish(new Error('Autorisation Google refusée ou invalide.'));
       if(typeof r.scope!=='string'||!r.scope.split(/\s+/).includes(SCOPE))return finish(new Error('Accès Drive non accordé.'));
       token=r.access_token;expires=now()+Number(r.expires_in)*1000;finish(null,{connected:true});
      },error_callback:()=>finish(new Error('Connexion Google interrompue.'))});
     client.requestAccessToken({prompt:'select_account consent'});
    } catch {finish(new Error('Impossible d’ouvrir la connexion Google.'));}
   });
  },
  disconnect(){generation++;token=null;expires=0;},
  status(){return {connected:!!token&&now()<expires-30000};},
  async withToken(action){if(!token||now()>=expires-30000){token=null;throw new Error('Reconnecte Google Drive.');}return action(token);}
 };
}
