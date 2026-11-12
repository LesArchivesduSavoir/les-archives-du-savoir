import worker from './worker.mjs';
import {createFirebaseAuth} from './firebase-auth.mjs';
import {openDatabase,d1} from './database.mjs';
import {firebaseApiKey,googleWebClientId} from './config.mjs';
import {createGoogleDriveSession} from './google-drive-session.mjs';
import {createSqliteStore} from './sqlite-store.mjs';
import {pushLibrary,pullLibrary} from './drive.mjs';
try {
 if(typeof DecompressionStream!=='function')throw Error('Navigateur incompatible : utilise une version récente de Chrome, Edge ou Firefox.');
 const parts=await Promise.all(Array.from({length:9},async(_,i)=>{const response=await fetch(new URL(`../../vendor/sql-wasm-${String(i).padStart(2,'0')}.txt`,import.meta.url));if(!response.ok)throw Error('Moteur de stockage introuvable.');return response.text();}));
 const compressed=Uint8Array.from(atob(parts.join('')),c=>c.charCodeAt(0));
 const wasmBinary=new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
 const SQL=await window.initSqlJs({wasmBinary});
 const schema=await (await fetch(new URL('./schema.sql',import.meta.url))).text();
 if(!((location.hostname==='localhost'&&location.port==='8788'&&location.protocol==='http:') || location.origin==='https://les-archives-du-savoir.pages.dev'))throw Error('Adresse de préversion non autorisée.');
 const transaction=await openDatabase(SQL,schema);const store=createSqliteStore(transaction);const firebase=createFirebaseAuth({apiKey:firebaseApiKey});let cookie='',currentUser=null,driveSession=null,syncBusy=false;
 window.archivesDesktop={
  driveSyncAvailable:true,
  isDriveBusy:()=>syncBusy,
  async drive(action){
   if(!currentUser)return {ok:false,error:'Connecte-toi d’abord au compte.',connected:false};
   if(action==='status')return {ok:true,connected:!!driveSession?.status().connected,rememberAvailable:false,message:'PRÉVERSION : utilise uniquement un compte Google et des carnets de test. Connexion temporaire.'};
   if(action==='disconnect'){driveSession?.disconnect();driveSession=null;return {ok:true,connected:false,message:'Drive déconnecté de cet onglet.'};}
   if(action==='connect'){
    try{driveSession??=createGoogleDriveSession({clientId:googleWebClientId,google:window.google});await driveSession.connect();return {ok:true,connected:true,message:'Drive de test connecté temporairement. Utilise uniquement des carnets fictifs.'};}
    catch(e){return {ok:false,connected:false,error:e.message};}
   }
   if(action==='push'||action==='pull'){
    if(syncBusy)return {ok:false,error:'Une opération est déjà en cours.'};
    if(!driveSession?.status().connected)return {ok:false,connected:false,error:'Connecte d’abord le Drive de test.'};
    if(!window.confirm(action==='push' ? 'PRÉVERSION : utiliser un compte Google de test et créer une sauvegarde fictive sur son Drive ? Ne continue pas avec tes vraies données.' : 'PRÉVERSION : récupérer une sauvegarde fictive du Drive de test ? Les modifications locales non envoyées sont protégées.'))return {ok:false,error:'Opération annulée.'};
    syncBusy=true;
    try{const userId=currentUser.id;const result=await driveSession.withToken(token=>(action==='push'?pushLibrary:pullLibrary)({store,userId,token}));return {ok:true,result};}
    catch(e){return {ok:false,connected:!!driveSession?.status().connected,error:e.message};}
    finally{syncBusy=false;}
   }
   return {ok:false,error:'Commande Drive inconnue.'};
  },
  async request(path,options={}) {
   if(syncBusy && path==='/api/logout')return {ok:false,status:409,data:{error:'Attends la fin de la synchronisation avant de te déconnecter.'}};
   if(typeof path!=='string'||!/^\/api\/[a-zA-Z0-9_/?=&-]+$/.test(path))throw Error('Requête invalide.');
   const method=options.method||'GET',headers={'Content-Type':'application/json','Origin':location.origin};if(cookie)headers['X-Archives-Session']=cookie;
   const request=new Request(new URL(path,location.origin),{method,headers,...(method!=='GET'&&options.body!==undefined?{body:options.body}:{})});
   const result=await transaction(async db=>{
    const response=await worker.fetch(request,{DB:d1(db),FIREBASE_AUTH:firebase}),data=await response.json();
    if(path==='/api/me')data.rememberAvailable=false;
    return {ok:response.ok,status:response.status,data,cookie:response.headers.get('x-archives-set-cookie')};
   },{write:method!=='GET'});
   if(result.cookie)cookie=result.cookie.split(';')[0];
   if(path==='/api/login'&&result.ok)currentUser=result.data.user;
   if(path==='/api/me')currentUser=result.data.user;
   if(path==='/api/logout'){currentUser=null;driveSession?.disconnect();driveSession=null;}
   return {ok:result.ok,status:result.status,data:result.data};
  }
 };
 await import('../app.js');
} catch(error) {
 const loading=document.getElementById('loading-screen');loading.textContent='Cette version de test ne peut pas démarrer : '+error.message;
}
