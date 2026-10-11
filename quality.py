import json,subprocess,sys
from pathlib import Path
forge=Path('C:/Users/matth/.codex/skills/img2threejs/forge')
def run(name,script,args):
 r=subprocess.run([sys.executable,'-X','utf8',str(forge/script),*args],capture_output=True,text=True,encoding='utf8');Path('evidence/'+name+'.txt').write_text(r.stdout+r.stderr,encoding='utf8');print(name,r.returncode);return r
run('reference-admission','stage1_intake/check_reference_admission.py',['reference/sls-nasa.jpg','--json'])
run('strict-spec','stage2_spec/validate_sculpt_spec.py',['object-sculpt-spec.json','--strict-quality'])
run('part-coverage','stage4_review/check_part_coverage.py',['--spec','object-sculpt-spec.json','--manifest','evidence/parts.json','--json','evidence/coverage.json'])
run('turntable','stage4_review/turntable_gate.py',[v for a in [0,90,180,270] for v in ['--capture',f'{a}=evidence/turntable-{a}.png']]+['--json'])
run('multi-angle','stage4_review/diagnose_render_multi_angle.py',['--reference','evidence/turntable-0.png','--orbit','evidence/turntable-90.png','--orbit','evidence/turntable-180.png','--orbit','evidence/turntable-270.png','--json'])
run('tier1-photo','stage4_review/diagnose_render.py',['--reference','reference/sls-nasa.jpg','--render','evidence/turntable-0.png','--spec','object-sculpt-spec.json','--pass-id','blockout','--in-place','--json'])
for step in ['image-analysis','reference-suitability','local-spec-search','pre-spec-assessment','detail-inventory','spec-authoring','strict-validation','build-current-pass','render-capture','review-contract-read']:
 run('mark-'+step,'state.py',['mark',step,'--state','.img2threejs/state.json','--evidence','evidence/intake.md' if step in ['image-analysis','reference-suitability'] else 'object-sculpt-spec.json' if step in ['local-spec-search','pre-spec-assessment','detail-inventory','spec-authoring','strict-validation'] else 'src/createSLSModel.ts' if step=='build-current-pass' else 'evidence/hero.png' if step=='render-capture' else 'README.md'])
for step in ['projection-route','material-evidence','material-spec-wiring','plugin-gates']:
 run('skip-'+step,'state.py',['mark',step,'--state','.img2threejs/state.json','--status','skipped','--reason','User explicitly requests cel shading. Nonphotographic procedural finish; generic domain; no plugin or photo material matching.'])
run('next-step','next.py',['--state','.img2threejs/state.json','object-sculpt-spec.json'])
data=Path('sls-cel.glb').read_bytes();print('GLB header',data[:4],len(data));assert data[:4]==b'glTF';assert int.from_bytes(data[8:12],'little')==len(data)
