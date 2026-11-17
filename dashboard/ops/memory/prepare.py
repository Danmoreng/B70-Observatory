"""Explicit, pinned local CPU build. No system install or runtime download."""
import hashlib,json,os,pathlib,shutil,subprocess,time,urllib.request,zipfile,datetime
from zoneinfo import ZoneInfo
ROOT=pathlib.Path(__file__).resolve().parents[2]
V=ROOT/'build/memory-vendor';V.mkdir(parents=True,exist_ok=True)
OUT=ROOT/'build/memory-runtime';OUT.mkdir(parents=True,exist_ok=True)
PINS={'bettersearch':'327d8c87b3b9f543a3a9103f1e95553e4b5471b9','llama':'ac8e1694d837b11ed0aab944a6a2eee34b9c4d80','modelRevision':'58faf90940886df2d62be555c8765d00dac362c5','modelSha256':'68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216','vecVersion':'0.1.9','visionProjectorSha256':'d2033b3cd0223cfb2e7a2b50dc80a664c78c816d375f5b017ec3ef80ee0bc766'}
def checktime():
 n=datetime.datetime.now(ZoneInfo('Europe/Berlin'))
 if (n.hour,n.minute)>=(22,35):raise RuntimeError('Too close to daily wind-down for a native build')
def download(url,path,sha):
 if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()==sha:return
 print('Downloading',path.name,flush=True)
 part=path.with_suffix(path.suffix+'.part')
 with urllib.request.urlopen(url,timeout=60) as r,part.open('wb') as f:shutil.copyfileobj(r,f,1024*1024)
 assert hashlib.sha256(part.read_bytes()).hexdigest()==sha,'Checksum mismatch: '+str(path)
 part.replace(path)
def run(args,**kw):
 checktime();subprocess.run(args,check=True,timeout=600,**kw)
checktime()
llama=V/'llama'
if not (llama/'CMakeLists.txt').exists():
 run(['git','init',str(llama)])
 run(['git','-C',str(llama),'fetch','--depth=1','https://github.com/ggml-org/llama.cpp.git',PINS['llama']])
 run(['git','-C',str(llama),'checkout','--detach','FETCH_HEAD'])
assert subprocess.check_output(['git','-C',str(llama),'rev-parse','HEAD'],text=True).strip()==PINS['llama']
assert not subprocess.check_output(['git','-C',str(llama),'status','--porcelain','--untracked-files=no'],text=True).strip(), 'Modified llama.cpp vendor cache; use a clean pinned checkout'
download('https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp',V/'json.hpp','aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63')
download('https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/sqlite-vec-0.1.9-amalgamation.zip',V/'vec.zip','b87cdda12112657ba5ab8842f0088a4090982eaf41f22b2bd6d495b81765a8c9')
vec=V/'vec';vec.mkdir(exist_ok=True)
with zipfile.ZipFile(V/'vec.zip') as archive:
 for target in ['sqlite-vec.c','sqlite-vec.h']:
  name=next(n for n in archive.namelist() if pathlib.PurePosixPath(n).name==target)
  (vec/target).write_bytes(archive.read(name))
run(['cmake','-S',str(ROOT/'ops/memory'),'-B',str(V/'build'),'-G','Ninja','-DCMAKE_BUILD_TYPE=Release','-DMEMORY_VENDOR='+str(V)])
run(['cmake','--build',str(V/'build'),'--target','b70-memory-embedding','b70-memory-vision','vec0','-j','3'])
for name in ['b70-memory-embedding','b70-memory-vision','vec0.so']:shutil.copy2(V/'build'/name,OUT/name)
shutil.copy2(llama/'LICENSE',OUT/'llama-LICENSE.txt')
# Reused source and full license remain alongside the runtime.
for name in ['BetterSearch-LICENSE.txt','NOTICE.txt','sqlite-vec-LICENSE.txt','json-LICENSE.txt','vision-dependencies-LICENSE.txt']:shutil.copy2(ROOT/'ops/memory'/name,OUT/name)
files=[{'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='manifest.json']
(OUT/'manifest.json').write_text(json.dumps({'version':1,'backend':'cpu','pins':PINS,'sourceSha256':hashlib.sha256((ROOT/'ops/memory/embedding.cpp').read_bytes()+(ROOT/'ops/memory/CMakeLists.txt').read_bytes()+(ROOT/'ops/memory/vision.cpp').read_bytes()).hexdigest(),'files':files},indent=2)+'\n')
checktime()
download('https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/'+PINS['modelRevision']+'/embeddinggemma-2-BF16.gguf?download=true',ROOT/'build/embeddinggemma-2-BF16.gguf',PINS['modelSha256'])
download('https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/'+PINS['modelRevision']+'/mmproj-embeddinggemma-2-BF16.gguf?download=true',ROOT/'build/mmproj-embeddinggemma-2-BF16.gguf','d2033b3cd0223cfb2e7a2b50dc80a664c78c816d375f5b017ec3ef80ee0bc766')
print('Pinned CPU memory runtime and model prepared',flush=True)
