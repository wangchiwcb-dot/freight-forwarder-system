import { DatabaseSync } from 'node:sqlite';
import { searchQuery } from '../worker/search';
import { DEFAULT_CRITERIA } from '../src/domain/search';

const db=new DatabaseSync('.local/d1-import/freight-quotes.sqlite',{readOnly:true});
try {
  const snapshot=db.prepare("SELECT id FROM dataset_snapshots WHERE source_kind='published_json' ORDER BY id LIMIT 1").get() as {id:string};
  const query=searchQuery({criteria:{...DEFAULT_CRITERIA,actualKg:300,volumeCbm:1,pieces:10},page:1,pageSize:15},snapshot.id);
  for(const [variant,sql] of [['previous-fee-join',query.sql.replace('f.quote_version_id=m.id AND f.tier_id=m.tier_id','f.tier_id=m.tier_id')],['indexed-fee-join',query.sql]]){
    const plan=db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...query.args) as {detail:string}[];
    const start=performance.now();db.prepare(sql).get(...query.args);
    console.log(JSON.stringify({variant,ms:Math.round(performance.now()-start),feeJoins:plan.filter(row=>/\bf\b/.test(row.detail))}));
  }
}finally{db.close();}
