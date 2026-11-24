require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const Stripe = require('stripe');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const dataDir = process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || !process.env.ADMIN_PASSWORD)) {
 throw new Error('SESSION_SECRET and ADMIN_PASSWORD must be set in production.');
}
const db = new Database(path.join(dataDir, 'replab.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, brand TEXT DEFAULT '',
 category TEXT DEFAULT 'Clothing', size TEXT DEFAULT 'One size', condition TEXT DEFAULT 'Pre-loved',
 price_cents INTEGER NOT NULL, image_url TEXT DEFAULT '', description TEXT DEFAULT '',
 active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT, email TEXT, phone TEXT,
 address TEXT, postcode TEXT, items_json TEXT NOT NULL, total_cents INTEGER NOT NULL,
 status TEXT DEFAULT 'Pending payment', stripe_session_id TEXT UNIQUE,
 payment_intent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (!count) {
 const seed = db.prepare(`INSERT INTO products (name,brand,category,size,condition,price_cents,image_url,description) VALUES (?,?,?,?,?,?,?,?)`);
 [
  ['Vintage Sports Hoodie','Vintage','Hoodies','M','Very good',3200,'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=900','A comfortable vintage-style sports hoodie.'],
  ['Classic Denim Jacket','Denim','Jackets','L','Good',3800,'https://images.unsplash.com/photo-1543076447-215ad9ba6923?w=900','A timeless denim layer, ready for a new home.'],
  ['Everyday Graphic Tee','Replab pick','T-Shirts','M','Very good',1800,'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=900','Easy everyday tee in pre-loved condition.'],
  ['Relaxed Track Pants','Sportswear','Trousers','S','Good',2600,'https://images.unsplash.com/photo-1552902865-b72c031ac5ea?w=900','Relaxed fit track pants.']
 ].forEach(p => seed.run(...p));
}
const stripe = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_') ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const currency = (process.env.CURRENCY || 'eur').toLowerCase();
const money = cents => new Intl.NumberFormat('en-IE',{style:'currency',currency:currency.toUpperCase()}).format(cents/100);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
// Stripe requires the raw request body to verify webhook signatures.
app.post('/api/stripe-webhook', express.raw({type:'application/json'}), (req,res) => {
 if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(400);
 let event;
 try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
 catch (err) { console.error('Webhook signature error:', err.message); return res.sendStatus(400); }
 if (event.type === 'checkout.session.completed') {
  const s = event.data.object;
  db.prepare(`UPDATE orders SET status='Paid', payment_intent=? WHERE stripe_session_id=?`).run(s.payment_intent || null, s.id);
 }
 if (event.type === 'checkout.session.expired') {
  db.prepare(`UPDATE orders SET status='Payment expired' WHERE stripe_session_id=? AND status='Pending payment'`).run(event.data.object.id);
 }
 res.json({received:true});
});
app.use(express.json({limit:'200kb'}));
app.use(session({
 store: new SQLiteStore({ db:'sessions.sqlite', dir:dataDir }),
 secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
 resave:false, saveUninitialized:false,
 cookie:{ httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', maxAge:8*60*60*1000 }
}));
app.use(express.static(path.join(__dirname,'public')));
const checkoutLimiter = rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:true,legacyHeaders:false});
const loginLimiter = rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false});
const adminOnly = (req,res,next) => req.session && req.session.admin ? next() : res.status(401).json({error:'Please sign in to the owner dashboard.'});

app.get('/api/products', (req,res) => {
 const rows = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY created_at DESC,id DESC').all();
 res.json(rows.map(p=>({...p,price:money(p.price_cents)})));
});
app.post('/api/checkout', checkoutLimiter, async (req,res) => {
 try {
  if (!stripe) return res.status(503).json({error:'Online payments are not configured yet. The owner must add Stripe keys.'});
  const {items,customer} = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length>30) return res.status(400).json({error:'Your basket is empty or invalid.'});
  if (!customer || !customer.name || !customer.email || !customer.address || !customer.postcode) return res.status(400).json({error:'Please complete your name, email and delivery address.'});
  const ids = [...new Set(items.map(i=>Number(i.id)))];
  if (ids.some(id=>!Number.isInteger(id))) return res.status(400).json({error:'Invalid item in basket.'});
  const products = db.prepare(`SELECT * FROM products WHERE active=1 AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  const byId = new Map(products.map(p=>[p.id,p]));
  const clean = [];
  for (const item of items) {
   const p = byId.get(Number(item.id)), qty = Number(item.quantity);
   if (!p || !Number.isInteger(qty) || qty<1 || qty>5) return res.status(400).json({error:'An item is unavailable or has an invalid quantity.'});
   clean.push({id:p.id,name:p.name,size:p.size,quantity:qty,unit_price_cents:p.price_cents});
  }
  const total = clean.reduce((sum,i)=>sum+i.unit_price_cents*i.quantity,0);
  const info = {name:String(customer.name).slice(0,100),email:String(customer.email).slice(0,200),phone:String(customer.phone||'').slice(0,40),address:String(customer.address).slice(0,250),postcode:String(customer.postcode).slice(0,30)};
  const inserted = db.prepare(`INSERT INTO orders (customer_name,email,phone,address,postcode,items_json,total_cents) VALUES (?,?,?,?,?,?,?)`).run(info.name,info.email,info.phone,info.address,info.postcode,JSON.stringify(clean),total);
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const checkout = await stripe.checkout.sessions.create({
   mode:'payment', customer_email:info.email,
   line_items:clean.map(i=>({quantity:i.quantity,price_data:{currency,unit_amount:i.unit_price_cents,product_data:{name:`${i.name} — Size ${i.size}`}}})),
   success_url:`${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
   cancel_url:`${base}/?checkout=cancelled`,
   billing_address_collection:'auto',
   shipping_address_collection:{allowed_countries:['IE']},
   metadata:{order_id:String(inserted.lastInsertRowid)}
  });
  db.prepare('UPDATE orders SET stripe_session_id=? WHERE id=?').run(checkout.id,inserted.lastInsertRowid);
  res.json({url:checkout.url});
 } catch(err) { console.error(err); res.status(500).json({error:'Could not start checkout. Please try again.'}); }
});
app.post('/api/admin/login', loginLimiter, (req,res)=>{
 const pass = process.env.ADMIN_PASSWORD;
 if (!pass || pass==='choose-a-strong-unique-password') return res.status(503).json({error:'Owner login is not configured. Set ADMIN_PASSWORD in the environment.'});
 if (!req.body || req.body.password !== pass) return res.status(401).json({error:'Incorrect password.'});
 req.session.regenerate(err=>{ if(err) return res.sendStatus(500); req.session.admin=true; res.json({ok:true}); });
});
app.post('/api/admin/logout', adminOnly, (req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/me', (req,res)=>res.json({authenticated:!!(req.session&&req.session.admin)}));
app.get('/api/admin/orders', adminOnly, (req,res)=>{
 const rows=db.prepare('SELECT * FROM orders ORDER BY datetime(created_at) DESC,id DESC').all();
 res.json(rows.map(o=>({...o,items:JSON.parse(o.items_json),total:money(o.total_cents)})));
});
app.patch('/api/admin/orders/:id', adminOnly, (req,res)=>{
 const allowed=['Paid','Processing','Shipped','Completed','Cancelled','Payment expired'];
 if(!allowed.includes(req.body.status)) return res.status(400).json({error:'Invalid order status.'});
 const result=db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status,Number(req.params.id));
 if(!result.changes) return res.sendStatus(404); res.json({ok:true});
});
app.post('/api/admin/products', adminOnly, (req,res)=>{
 const p=req.body||{}; const price=Math.round(Number(p.price)*100);
 if(!p.name||!Number.isFinite(price)||price<1||price>1000000) return res.status(400).json({error:'Add a product name and valid price.'});
 const r=db.prepare(`INSERT INTO products(name,brand,category,size,condition,price_cents,image_url,description) VALUES(?,?,?,?,?,?,?,?)`).run(String(p.name).slice(0,100),String(p.brand||'').slice(0,80),String(p.category||'Clothing').slice(0,50),String(p.size||'One size').slice(0,30),String(p.condition||'Pre-loved').slice(0,40),price,String(p.image_url||'').slice(0,1000),String(p.description||'').slice(0,500));
 res.json({ok:true,id:r.lastInsertRowid});
});
app.patch('/api/admin/products/:id', adminOnly, (req,res)=>{
 const result=db.prepare('UPDATE products SET active=? WHERE id=?').run(req.body.active?1:0,Number(req.params.id));
 if(!result.changes)return res.sendStatus(404);res.json({ok:true});
});
app.get('/api/admin/products', adminOnly, (req,res)=>res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(p=>({...p,price:money(p.price_cents)}))));
app.get('/api/health', (req,res)=>res.json({ok:true,paymentsConfigured:!!stripe}));
const port=process.env.PORT||3000;
app.listen(port,()=>console.log(`Replab is running on port ${port}`));
