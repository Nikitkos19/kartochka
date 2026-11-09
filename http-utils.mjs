function invalidBody(message, status=400) {
  return Object.assign(new Error(message), {status});
}

export function readBody(req, max=40_000) {
  return new Promise((resolve, reject) => {
    let size=0, failed=false;
    const chunks=[];
    const fail=error=>{if(failed)return;failed=true;chunks.length=0;reject(error)};
    req.on('data', chunk=>{
      if(failed)return;
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      size+=bytes.length;
      if(size>max)return fail(invalidBody('Запрос слишком большой.',413));
      chunks.push(bytes);
    });
    req.on('end',()=>{
      if(failed)return;
      try {
        const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
        resolve(JSON.parse(raw||'{}'));
      } catch {fail(invalidBody('Некорректный JSON или кодировка запроса.'))}
    });
    req.on('aborted',()=>fail(invalidBody('Передача запроса прервана.')));
    req.on('error',fail);
  });
}

export function parseCookies(header='') {
  const cookies=Object.create(null);
  if(typeof header!=='string')return cookies;
  for(const part of header.split(';')) {
    const index=part.indexOf('=');
    if(index<1)continue;
    const name=part.slice(0,index).trim();
    if(!name)continue;
    try {cookies[name]=decodeURIComponent(part.slice(index+1).trim())} catch {/* An invalid cookie is not a valid session. */}
  }
  return cookies;
}
