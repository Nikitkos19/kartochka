from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from io import BytesIO
import json, zipfile, xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parent
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw): super().__init__(*a,directory=str(ROOT),**kw)
 def do_POST(self):
  if self.path!='/api/xlsx': self.send_error(404);return
  try:
   n=int(self.headers.get('Content-Length',0))
   if n>10_000_000: raise ValueError('Максимум 10 МБ')
   z=zipfile.ZipFile(BytesIO(self.rfile.read(n))); ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
   strings=[]
   if 'xl/sharedStrings.xml' in z.namelist(): strings=[''.join(t.itertext()) for t in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',ns)]
   sheets=sorted(x for x in z.namelist() if x.startswith('xl/worksheets/sheet') and x.endswith('.xml'))
   rows=[]
   for r in ET.fromstring(z.read(sheets[0])).findall('.//s:row',ns):
    row=[]
    for c in r.findall('s:c',ns):
     col=''.join(x for x in c.attrib.get('r','A') if x.isalpha());idx=0
     for x in col: idx=idx*26+ord(x)-64
     while len(row)<idx:row.append('')
     v=c.find('s:v',ns); val=v.text if v is not None else ''
     if c.attrib.get('t')=='s':val=strings[int(val)]
     elif c.attrib.get('t')=='inlineStr': val=''.join(c.find('s:is',ns).itertext())
     row[idx-1]=val or ''
    rows.append(row)
   body=json.dumps(rows,ensure_ascii=False).encode();self.send_response(200);self.send_header('Content-Type','application/json; charset=utf-8');self.end_headers();self.wfile.write(body)
  except Exception:
   self.send_response(400);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'error':'Не удалось прочитать XLSX. Используйте обычную книгу без пароля или CSV.'},ensure_ascii=False).encode())
if __name__=='__main__':
 print('Local platform: http://127.0.0.1:8765',flush=True)
 ThreadingHTTPServer(('127.0.0.1',8765),Handler).serve_forever()
