import {query} from './database.mjs';
import {validateSnapshot} from './snapshot.mjs';
function capture(db,uid) {
 const books=query(db,'SELECT id,title,description,cover_color,cover_image_data,page_count,created_at,updated_at FROM notebooks WHERE user_id=? ORDER BY id',[uid]);
 return {format:'archives-library-v1',userId:uid,notebooks:books.map(b=>{const l=query(db,'SELECT is_favorite,last_opened_at,deleted_at FROM notebook_library_state WHERE notebook_id=? AND user_id=?',[b.id,uid])[0];return {...b,pages:query(db,'SELECT id,page_number,content_json,updated_at FROM notebook_pages WHERE notebook_id=? ORDER BY page_number,id',[b.id]),bookmarks:query(db,'SELECT id,page_number,label,color,created_at FROM bookmarks WHERE notebook_id=? ORDER BY id',[b.id]),library:l&&(l.is_favorite||l.deleted_at)?{is_favorite:l.is_favorite,last_opened_at:null,deleted_at:l.deleted_at}:null};})};
}
export function createSqliteStore(transaction){return {
 read(uid){return transaction((db,generation)=>({generation,snapshot:capture(db,uid),sync:query(db,'SELECT head,snapshot_hash FROM archive_sync_state WHERE user_id=?',[uid])[0]||null}));},
 recordPush(uid,generation,head,hash){return transaction(db=>{db.run('INSERT INTO archive_sync_state(user_id,head,snapshot_hash) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET head=excluded.head,snapshot_hash=excluded.snapshot_hash',[uid,head,hash]);},{write:true,expected:generation});},
 applyPull(uid,generation,snapshot,head,hash){validateSnapshot(snapshot,uid);return transaction(db=>{
  const previous=capture(db,uid);db.run('INSERT INTO archive_sync_backups(user_id,snapshot,created_at) VALUES(?,?,?)',[uid,JSON.stringify(previous),new Date().toISOString()]);
  const recent=new Map(query(db,'SELECT notebook_id,last_opened_at FROM notebook_library_state WHERE user_id=? AND last_opened_at IS NOT NULL',[uid]).map(x=>[x.notebook_id,x.last_opened_at]));
  db.run('DELETE FROM notebooks WHERE user_id=?',[uid]);
  for(const b of snapshot.notebooks){db.run('INSERT INTO notebooks(id,user_id,title,description,cover_color,cover_image_data,page_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',[b.id,uid,b.title,b.description,b.cover_color,b.cover_image_data,b.page_count,b.created_at,b.updated_at]);for(const p of b.pages)db.run('INSERT INTO notebook_pages(id,notebook_id,page_number,content_json,updated_at) VALUES(?,?,?,?,?)',[p.id,b.id,p.page_number,p.content_json,p.updated_at]);for(const m of b.bookmarks)db.run('INSERT INTO bookmarks(id,notebook_id,page_number,label,color,created_at) VALUES(?,?,?,?,?,?)',[m.id,b.id,m.page_number,m.label,m.color,m.created_at]);if(b.library||recent.has(b.id))db.run('INSERT INTO notebook_library_state(notebook_id,user_id,is_favorite,last_opened_at,deleted_at) VALUES(?,?,?,?,?)',[b.id,uid,b.library?.is_favorite||0,recent.get(b.id)||null,b.library?.deleted_at||null]);}
  if(JSON.stringify(capture(db,uid))!==JSON.stringify(snapshot))throw Error('Restauration annulée : vérification du contenu impossible.');
  db.run('INSERT INTO archive_sync_state(user_id,head,snapshot_hash) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET head=excluded.head,snapshot_hash=excluded.snapshot_hash',[uid,head,hash]);
 },{write:true,expected:generation});}
};}
