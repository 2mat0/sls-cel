"""Store official vector outlines as source; no runtime asset fetches or raster textures."""
from pathlib import Path
import json
import pymupdf as fitz
root=Path(__file__).parent
page=fitz.open(root/'reference/america250-brand.pdf')[5]
drawings=page.get_drawings()
def pt(p):return f'{p.x:.5f},{p.y:.5f}'
paths=[]
for item in drawings[18:45]:
 commands=[];previous=None
 for segment in item['items']:
  if segment[0]=='l':
   _,a,b=segment
   if a!=previous:commands.append('M'+pt(a))
   commands.append('L'+pt(b));previous=b
  elif segment[0]=='c':
   _,a,b,c,d=segment
   if a!=previous:commands.append('M'+pt(a))
   commands.append('C'+pt(b)+' '+pt(c)+' '+pt(d));previous=d
  elif segment[0]=='re':
   r=segment[1];commands.append(f'M{r.x0},{r.y0}H{r.x1}V{r.y1}H{r.x0}Z');previous=None
 if item.get('closePath'):commands.append('Z')
 color='#'+''.join(f'{round(v*255):02x}' for v in item['fill'])
 paths.append(f'<path fill="{color}" fill-rule="evenodd" d="{" ".join(commands)}"/>')
svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="298 137 116 80">'+''.join(paths)+'</svg>'
(root/'reference/america250-logo.svg').write_text(svg,encoding='utf8')
assets={k:(root/('reference/'+file)).read_text(encoding='utf8') for k,file in [('worm','nasa-worm.svg'),('insignia','nasa-insignia.svg'),('america250','america250-logo.svg')]}
(root/'src/liveryVectors.ts').write_text('// NASA and America250 vector outlines. See reference/livery-sources.json.\nexport const liveryVectors = '+json.dumps(assets)+';\n',encoding='utf8')
sources={'mission':'Artemis II','sources':[{'url':'https://www.nasa.gov/gallery/artemis-ii-launch/','use':'Launch photograph: booster NASA worms and AMERICA 250 placement, Orion NASA/ESA and flag.'},{'url':'https://www.nasa.gov/image-article/nasas-moon-rocket-celebrates-250-years-of-american-innovation/','use':'AMERICA 250 booster close-up.'},{'url':'https://www.nasa.gov/wp-content/uploads/2025/12/sls-5558-artemis-ii-sls-reference-guide.pdf','page':31,'use':'National and agency livery inventory.'},{'url':'https://america250wa.org/wp-content/uploads/2026/01/America250_Visual_Identity_Guidelines_TM.pdf','page':6,'use':'Primary AMERICA 250 logo vector paths 18 through 44 from PDF page 6.'},{'url':'https://upload.wikimedia.org/wikipedia/commons/a/a3/NASA_Worm_logo.svg','use':'NASA worm vector outlines, digitized from NASA graphics standard.'},{'url':'https://www.nasa.gov/wp-content/themes/nasa/assets/images/nasa-logo.svg','use':'NASA insignia vector outlines.'}],'approximation':'Major flight livery reproduced as geometry. Placement adapted to the existing stylized model; rear placement inferred. Tiny serial stencils and every engineering target are not reproduced.'}
(root/'reference/livery-sources.json').write_text(json.dumps(sources,indent=2),encoding='utf8')
specPath=root/'object-sculpt-spec.json';spec=json.loads(specPath.read_text())
for c in spec['componentTree']:
 marks=['AMERICA 250 primary logo','vertical red NASA worm'] if c['id'].startswith('booster-') else ['NASA insignia','ESA identifier','NASA worm','U.S. flag','USA'] if c['id']=='upper-stack' else []
 c['localFeatures']=[f for f in c['localFeatures'] if not f['id'].startswith('artemis-ii-livery-')]+[{'id':'artemis-ii-livery-'+c['id'],'type':'decal or label area','description':', '.join(marks),'geometryEffect':'Vector shape meshes conformed to faceted cylinder; follows owning assembly during explode.','confidence':.85,'evidenceRefs':['reference/livery-sources.json']}] if marks else c['localFeatures']
spec['liveryRevision']=sources
specPath.write_text(json.dumps(spec,indent=2),encoding='utf8')
