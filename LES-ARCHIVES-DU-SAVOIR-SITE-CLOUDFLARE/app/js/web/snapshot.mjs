const MAX_BYTES = 20 * 1024 * 1024, idRe = /^[a-f0-9-]{36}$/i;
export function validateSnapshot(value, userId) {
 const bad=()=>{throw new Error('Sauvegarde Drive invalide ou incompatible.');};
 if(!value || value.format!=='archives-library-v1'||value.userId!==userId||!Array.isArray(value.notebooks)||value.notebooks.length>2000)bad();
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_BYTES)throw new Error('La bibliothèque dépasse la limite de 20 Mo de ce prototype.');
 const ids=new Set(),isId=x=>typeof x==='string'&&idRe.test(x),text=(s,n)=>typeof s==='string'&&s.length<=n, nullable=(s,n)=>s===null||text(s,n),time=s=>text(s,50), color=s=>typeof s==='string'&&/^#[0-9a-f]{6}$/i.test(s);
 for(const b of value.notebooks){
  if(!b||!isId(b.id)||ids.has(b.id)||!text(b.title,80)||!b.title||!text(b.description,500)||!color(b.cover_color)||!nullable(b.cover_image_data,950000)||!Number.isInteger(b.page_count)||b.page_count<0||b.page_count>120||!time(b.created_at)||!time(b.updated_at)||!Array.isArray(b.pages)||b.pages.length>120||!Array.isArray(b.bookmarks)||b.bookmarks.length>10000)bad();
  if(b.cover_image_data && !/^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(b.cover_image_data))bad();
  ids.add(b.id);const pnums=new Set();
  for(const p of b.pages){if(!p||!isId(p.id)||ids.has(p.id)||!Number.isInteger(p.page_number)||p.page_number<1||p.page_number>120||pnums.has(p.page_number)||!text(p.content_json,1000000)||!time(p.updated_at))bad();let c;try{c=JSON.parse(p.content_json)}catch{bad()}if(!c||!text(c.html,900000))bad();ids.add(p.id);pnums.add(p.page_number);}
  for(const m of b.bookmarks){if(!m||!isId(m.id)||ids.has(m.id)||!Number.isInteger(m.page_number)||m.page_number<1||m.page_number>120||!text(m.label,80)||!color(m.color)||!time(m.created_at))bad();ids.add(m.id);}
  if(b.library!==null&&(!b.library||![0,1].includes(b.library.is_favorite)||!nullable(b.library.last_opened_at,50)||!nullable(b.library.deleted_at,50)))bad();
 }
 return value;
}
export async function hashText(text) {
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
 return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,"0")).join("");
}
export async function hashSnapshot(snapshot) { return hashText(JSON.stringify(snapshot)); }
