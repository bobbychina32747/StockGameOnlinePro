const fs=require('node:fs'),path=require('node:path');const root=path.join(__dirname,'..');
const study=path.join(__dirname,'study-news-impact.cjs');let source=fs.readFileSync(study,'utf8');
source=source.replace(/function publicationBounds\(event\)\{[\s\S]*?function firstAffected\(row,publishedAt\)\{[^\n]+\}\r?\n/,"const {publicationBounds,firstAffected}=require('./news-time.cjs');\n");fs.writeFileSync(study,source);
const style=path.join(root,'apps/web/src/styles.css');fs.writeFileSync(style,fs.readFileSync(style,'utf8').replace('background:var(--surface);color:var(--text)','background:var(--panel);color:var(--text)'));
const app=path.join(root,'apps/web/src/App.tsx');fs.writeFileSync(app,fs.readFileSync(app,'utf8').replace("changeOwner(session.principal?.owner??'');","changeOwner(session.principal?.owner??'');setNotices([]);setEventsOpen(false);"));
require('./runtime.cjs');const packageFile=path.join(root,'package.json');const packageData=JSON.parse(fs.readFileSync(packageFile,'utf8'));
for(const group of ['dependencies','devDependencies'])for(const name of Object.keys(packageData[group])){
 let found;try{found=require.resolve(name+'/package.json');}catch{let location=path.dirname(require.resolve(name));while(location!==path.dirname(location)){const candidate=path.join(location,'package.json');if(fs.existsSync(candidate)&&JSON.parse(fs.readFileSync(candidate,'utf8')).name===name){found=candidate;break;}location=path.dirname(location);}}
 if(found)packageData[group][name]=JSON.parse(fs.readFileSync(found,'utf8')).version;
}
fs.writeFileSync(packageFile,JSON.stringify(packageData,null,2)+'\n');
console.log('Synced manifest with tested local dependencies and finalized isolated public-data tools.');
