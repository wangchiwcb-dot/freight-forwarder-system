import fs from 'node:fs';
const source=JSON.parse(fs.readFileSync('analysis/latest-extract.json','utf8'));
const args=process.argv.slice(2);
for(const f of source.files.filter(f=>!args[0]||f.name.includes(args[0]))){
 console.log('\nFILE '+f.name);
 console.log(f.sheets.map(s=>`${s.name}(${s.rows},${s.state})`).join(' | '));
 const sheets=args[1]?f.sheets.filter(s=>s.name.includes(args[1])):f.sheets.filter(s=>!s.reference&&s.state==='visible'&&!/目录|说明|附加|赔|首页|协议|须知|更新|介绍|产品|禁|分区|地址库|航班|申报|汇总|封面|参考/.test(s.name)).slice(0,2);
 for(const s of sheets){console.log('\nSHEET '+s.name);for(const row of s.head.filter(r=>r.row<=(args[2]?Number(args[2]):15)))console.log(row.cells.map(c=>`${c.coord}=${String(c.formula?c.cached:c.value).slice(0,120).replaceAll('\n',' ')}`).join(' | '));}
}
