const db = require('./db');
db.prepare("UPDATE factories SET name='الدار' WHERE name='الرد'").run();
db.prepare("UPDATE deliveries SET factory_name='الدار' WHERE factory_name='الرد'").run();
console.log('done');
