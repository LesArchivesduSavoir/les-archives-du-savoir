// Base expérimentale : chaque opération charge et enregistre une copie SQLite
// sous verrou inter-onglets. Ne pas utiliser avec des données importantes.
export async function openDatabase(SQL,schema) {
 if(!navigator.locks)throw Error('Ce navigateur ne permet pas de protéger les modifications entre onglets.');
 const req=indexedDB.open('archives-web-drive-test-isole-v1',1);
 req.onupgradeneeded=()=>req.result.createObjectStore('state');
 const idb=await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
 const get=()=>new Promise((resolve,reject)=>{const tx=idb.transaction('state','readonly'),q=tx.objectStore('state').get('database');q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>reject(q.error)});
 const put=row=>new Promise((resolve,reject)=>{const tx=idb.transaction('state','readwrite');tx.objectStore('state').put(row,'database');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Enregistrement annulé.'))});
 return async function transaction(operation,{write=false,expected}={}) {
  return navigator.locks.request('archives-web-drive-test-sqlite',async()=>{
   const saved=await get(),generation=saved?.generation||0;if(expected!==undefined&&expected!==generation)throw Error('La bibliothèque locale a changé pendant la synchronisation. Rien n’a été remplacé.');
   const db=saved ? new SQL.Database(saved.bytes) : new SQL.Database();
   try {if(!saved){db.run(schema);db.run(`CREATE TABLE archive_sync_state (user_id TEXT PRIMARY KEY, head TEXT NOT NULL, snapshot_hash TEXT NOT NULL); CREATE TABLE archive_sync_backups (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);`);}db.run('PRAGMA foreign_keys=ON');
    const result=await operation(db,generation);
    if(write)await put({bytes:db.export(),generation:generation+1});
    return result;
   }finally{db.close();}
  });
 };
}
export function query(db,sql,args=[]) {const st=db.prepare(sql);try{st.bind(args);const rows=[];while(st.step())rows.push(st.getAsObject());return rows;}finally{st.free();}}
export function d1(db){return {prepare(sql){let args=[];const s={bind(...x){args=x;return s;},async first(col){const x=query(db,sql,args)[0];return x?(col===undefined?x:x[col]??null):null;},async all(){return {success:true,results:query(db,sql,args)};},async run(){db.run(sql,args);return {success:true,meta:{changes:db.getRowsModified()}};}};return s;}};}
