// Prototype de moteur navigateur, sans interface ni connexion OAuth.
// Ne jamais utiliser pour publier avant de respecter le contrat de stockage décrit dans README-WEB-ETAPE-1.md.
import {inspectRevisions} from './revision-graph.mjs';
import {validateSnapshot,hashSnapshot,hashText} from './snapshot.mjs';
const BASE='https://www.googleapis.com', MARK='archives-savoir-v1', MAX=20*1024*1024;
const uidOk=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(s);
async function api(fetchImpl,url,token,opts={}) {
 let r;
 try {r=await fetchImpl(url,{...opts,headers:{...(opts.headers||{}),Authorization:`Bearer ${token}`},redirect:'error'});}
 catch {throw new Error('Connexion Drive impossible. Les carnets locaux sont conservés.');}
 if(!r.ok) throw new Error(`Google Drive a refusé la requête (HTTP ${r.status}). Les carnets locaux sont conservés.`);
 return r;
}
export async function listDriveRevisions({token,userId,fetchImpl=fetch}) {
 if(!token||!uidOk(userId))throw new Error('Compte ou autorisation Drive invalide.');
 const q=`trashed = false and appProperties has { key='application' and value='${MARK}' } and appProperties has { key='owner' and value='${userId}' }`;
 let next,files=[],seen=new Set();
 do {
  if(next && seen.has(next)) throw new Error('Liste Drive répétée ; synchronisation annulée.');
  if(next) seen.add(next);
  const params=new URLSearchParams({q,pageSize:'100',fields:'nextPageToken,incompleteSearch,files(id,name,appProperties)'}); if(next)params.set('pageToken',next);
  const result=await (await api(fetchImpl,`${BASE}/drive/v3/files?${params}`,token)).json();
  if(result.incompleteSearch || !Array.isArray(result.files)) throw new Error('Liste Drive incomplète ; synchronisation annulée.');
  files.push(...result.files); if(files.length>2000||seen.size>2000)throw new Error('Trop de versions Drive pour ce prototype.');
  next=result.nextPageToken;
 } while(next);
 const revisions=files.map(f=>{const p=f.appProperties;if(!p||p.application!==MARK||p.owner!==userId||!p.revision||!p.hash||!f.id)throw new Error('Métadonnées Drive invalides.');return {id:p.revision,parents:p.parent?[p.parent]:[],fileId:f.id,hash:p.hash};});
 const graph=inspectRevisions(revisions);
 if(graph.incomplete)throw new Error('Historique Drive incomplet : synchronisation annulée. Les carnets locaux sont conservés.');
 if(graph.conflict)throw new Error('Plusieurs versions Drive sont en conflit. Aucun carnet local n’a été remplacé.');
 return {revisions,head:graph.heads[0]||null};
}
async function uploadRevision({token,userId,revision,parent,snapshot,fetchImpl}) {
 validateSnapshot(snapshot,userId);const data=JSON.stringify(snapshot),hash=await hashText(data),boundary=`archives_${crypto.randomUUID().replaceAll('-','')}`;
 const metadata={name:`Archives-du-Savoir-sauvegarde-${revision}.json`,mimeType:'application/json',appProperties:{application:MARK,owner:userId,revision,parent:parent||'',hash}};
 const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${data}\r\n--${boundary}--\r\n`;
 const r=await api(fetchImpl,`${BASE}/upload/drive/v3/files?uploadType=multipart&fields=id%2Cname`,token,{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
 const result=await r.json();if(!result.id)throw new Error('Réponse Drive invalide. Vérifie avant de réessayer.');
 const read=await api(fetchImpl,`${BASE}/drive/v3/files/${encodeURIComponent(result.id)}?alt=media`,token);const returned=await read.text();
 if(await hashText(returned)!==hash)throw new Error('Vérification de la sauvegarde Drive impossible. Les données locales sont intactes.');
}
// Le store doit garantir les transactions décrites dans le README, notamment contre les autres onglets.
export async function pushLibrary({store,userId,token,fetchImpl=fetch}) {
 const initial=await store.read(userId),remote=await listDriveRevisions({token,userId,fetchImpl}),local=initial.sync;
 if(local?.head&&!remote.head)throw new Error('La sauvegarde Drive est introuvable. Les carnets locaux sont conservés.');
 if((local?.head||null)!==remote.head)throw new Error('La version Drive a changé ou appartient à un autre appareil : récupère-la avant d’envoyer.');
 const snapshot=validateSnapshot(initial.snapshot,userId),hash=await hashSnapshot(snapshot),revision=crypto.randomUUID();
 if(local&&local.snapshot_hash===hash)return {unchanged:true,books:snapshot.notebooks.length};
 await uploadRevision({token,userId,revision,parent:remote.head,snapshot,fetchImpl});
 // Un autre appareil a pu publier en même temps. Il faut inspecter le graphe après envoi.
 const check=await listDriveRevisions({token,userId,fetchImpl});
 if(check.head!==revision)throw new Error('L’historique Drive a changé pendant l’envoi. Les carnets locaux sont conservés.');
 await store.recordPush(userId,initial.generation,revision,hash);
 return {revision,books:snapshot.notebooks.length};
}
export async function pullLibrary({store,userId,token,fetchImpl=fetch}) {
 const initial=await store.read(userId),local=initial.sync,before=validateSnapshot(initial.snapshot,userId),beforeHash=await hashSnapshot(before);
 if(local&&local.snapshot_hash!==beforeHash)throw new Error('Des modifications locales ne sont pas envoyées : récupération annulée pour les protéger.');
 if(!local&&before.notebooks.length)throw new Error('La bibliothèque locale contient déjà des carnets : récupération automatique refusée pour les protéger.');
 const remote=await listDriveRevisions({token,userId,fetchImpl});if(!remote.head)throw new Error('Aucune sauvegarde trouvée dans ce Drive pour ce compte.');
 if(remote.head===local?.head)return {unchanged:true};
 if(local&&!remote.revisions.some(r=>r.id===local.head))throw new Error('Historique Drive différent de cet appareil : récupération annulée.');
 const revision=remote.revisions.find(x=>x.id===remote.head);
 const response=await api(fetchImpl,`${BASE}/drive/v3/files/${encodeURIComponent(revision.fileId)}?alt=media`,token);
 const length=Number(response.headers.get('content-length')||0);if(length>MAX)throw new Error('Sauvegarde Drive trop volumineuse.');
 const data=await response.text();if(new TextEncoder().encode(data).byteLength>MAX||await hashText(data)!==revision.hash)throw new Error('Intégrité Drive invalide : aucune modification locale.');
 let snapshot;try{snapshot=JSON.parse(data)}catch{throw new Error('Sauvegarde Drive illisible.');}
 validateSnapshot(snapshot,userId);
 const check=await listDriveRevisions({token,userId,fetchImpl});if(check.head!==remote.head)throw new Error('La bibliothèque Drive a changé pendant la récupération. Réessaie.');
 await store.applyPull(userId,initial.generation,snapshot,remote.head,await hashSnapshot(snapshot));
 return {unchanged:false,books:snapshot.notebooks.length};
}
