/**
 * LegalDraft AI — Backend Node.js
 * Auth utilisateur (JWT) · Free doc unique · Paiements Stripe
 *
 * Stack : Express · bcryptjs · jsonwebtoken · Stripe · CORS · dotenv
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db       = require('./db');

const app        = express();
const PORT       = process.env.PORT || 4242;
const JWT_SECRET = process.env.JWT_SECRET || 'ld-dev-secret-CHANGE-IN-PROD';
const JWT_EXPIRY = '30d';
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'ld-admin-dev';

// ── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin:  process.env.FRONTEND_URL || '*',   // Mettez votre domaine en prod
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
}));

// ── JWT GUARD ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Non authentifié — token manquant.' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré — reconnectez-vous.' });
  }
}

// ── FRONTEND STATIQUE ────────────────────────────────────────────────────────
// Sert index.html et les assets depuis le même dossier que server.js
app.use(express.static(__dirname));

// Raw body pour les webhooks Stripe (avant express.json)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── PRIX ─────────────────────────────────────────────────────────────────────
const PRICES = {
  unit: 900,     // 9,00 €  en centimes
  pack: 2500,    // 25,00 € — pack 5 docs
  sub:  2900,    // 29,00 € — abonnement mensuel (NOTE: /create-subscription utilise
                 //           STRIPE_SUBSCRIPTION_PRICE_ID depuis .env, pas cette valeur.
                 //           sub ici sert uniquement si l'offre 'sub' est passée à /create-payment-intent.)
};

const CURRENCIES = {
  EUR: ['fr', 'be', 'tn', 'ma'],   // Europe + Maghreb
  XOF: ['ci', 'sn', 'ml'],         // UEMOA (FCFA)
  XAF: ['cm'],                      // CEMAC (FCFA)
};

// ── ROUTES ────────────────────────────────────────────────────────────────────

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ══════════════════════════════════════════════════════
   AUTH — Inscription / Connexion
══════════════════════════════════════════════════════ */

/**
 * POST /auth/register
 * Body : { email, password }
 * Réponse : { token, user: { id, email, freeDocUsed } }
 */
app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe requis.' });

  const emailClean = email.toLowerCase().trim();
  const emailRe    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(emailClean))
    return res.status(400).json({ error: 'Adresse email invalide.' });

  if (password.length < 6)
    return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum.' });

  if (db.getUserByEmail(emailClean))
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const user = db.createUser(emailClean, hash);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    console.log(`✅ Nouveau compte : ${user.email}`);
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, freeDocUsed: user.free_doc_used },
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Erreur serveur — réessayez.' });
  }
});

/**
 * POST /auth/login
 * Body : { email, password }
 * Réponse : { token, user: { id, email, freeDocUsed } }
 */
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe requis.' });

  const user = db.getUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });

  try {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    console.log(`🔑 Connexion : ${user.email}`);
    res.json({
      token,
      user: { id: user.id, email: user.email, freeDocUsed: user.free_doc_used },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Erreur serveur — réessayez.' });
  }
});

/**
 * GET /auth/me  (JWT requis)
 * Réponse : profil complet de l'utilisateur
 */
app.get('/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  res.json({
    id:              user.id,
    email:           user.email,
    freeDocUsed:     user.free_doc_used,
    freeDocUsedAt:   user.free_doc_used_at,
    freeDocType:     user.free_doc_type,
    currentPlan:     user.current_plan,
    createdAt:       user.created_at,
  });
});

/* ══════════════════════════════════════════════════════
   FREE DOC — Vérification + Claim
══════════════════════════════════════════════════════ */

/**
 * GET /free-doc/status  (JWT requis)
 * Réponse : { eligible: true|false }
 */
app.get('/free-doc/status', requireAuth, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ eligible: db.canUseFreeDocument(user) });
});

/**
 * POST /free-doc/claim  (JWT requis)
 * Body : { docType: string }
 * Réponse : { ok: true } ou 403 FREE_DOC_ALREADY_USED
 *
 * Protection backend : 1 document gratuit maximum par compte.
 * Toute tentative de contournement frontend est bloquée ici.
 */
app.post('/free-doc/claim', requireAuth, (req, res) => {
  const { docType = 'non renseigné' } = req.body || {};
  const user = db.getUserById(req.user.id);

  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  if (!db.canUseFreeDocument(user)) {
    console.warn(`⚠️  Free doc déjà utilisé — tentative : ${user.email}`);
    return res.status(403).json({
      error: 'Vous avez déjà utilisé votre document gratuit.',
      code:  'FREE_DOC_ALREADY_USED',
    });
  }

  try {
    db.markFreeDocumentAsUsed(user.id, docType);
    res.json({ ok: true, message: 'Document gratuit enregistré.' });
  } catch (err) {
    console.error('Free-doc claim error:', err.message);
    res.status(500).json({ error: 'Erreur serveur — réessayez.' });
  }
});

/* ══════════════════════════════════════════════════════
   ADMIN — Suivi des documents gratuits
══════════════════════════════════════════════════════ */

/**
 * GET /admin/free-doc-usage  (X-Admin-Key requis)
 * Liste tous les utilisateurs et leur usage du document gratuit.
 * Header : X-Admin-Key: <ADMIN_KEY>
 */
app.get('/admin/free-doc-usage', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY)
    return res.status(403).json({ error: 'Accès refusé.' });

  const users = db.getAllUsers();
  const log   = db.getFreeDocLog();

  res.json({
    total_users:     users.length,
    free_doc_used:   users.filter(u => u.free_doc_used).length,
    free_doc_unused: users.filter(u => !u.free_doc_used).length,
    users,
    log,
  });
});

/* ══════════════════════════════════════════════════════
   AI ENDPOINTS — Claude API
══════════════════════════════════════════════════════ */

/**
 * POST /api/chat  (JWT requis)
 * Body : { message: string, history: [{role, content}] }
 * Réponse : { response: string }
 */
app.post('/api/chat', requireAuth, async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message requis.' });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: "Tu es LexIA, un assistant juridique expert en droit français, droit du travail, droit OHADA et RGPD. Tu fournis des informations juridiques générales claires, structurées et précises. Tu ne donnes JAMAIS de conseil juridique personnalisé. Tu rappelles toujours de consulter un professionnel pour les cas spécifiques. Tu réponds toujours en français.",
      messages: [...history, { role: 'user', content: message }]
    });
    res.json({ response: result.content[0].text });
  } catch (err) {
    console.error('Chat AI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/analyze  (JWT requis)
 * Body : { text: string, filename: string }
 * Réponse : JSON d'analyse de contrat
 */
app.post('/api/analyze', requireAuth, async (req, res) => {
  const { text, filename = 'document' } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Texte requis.' });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      system: 'Tu es un expert en analyse de contrats juridiques français. Analyse le document fourni et retourne UNIQUEMENT un JSON valide sans markdown avec cette structure exacte: { "score": number(0-100), "scoreLabel": string, "clauses": [{"name":string,"present":boolean}], "risks": [{"text":string,"severity":"high"|"medium"|"low"}], "recommendations": [string], "summary": string }. Ne retourne aucun texte avant ou après le JSON.',
      messages: [{ role: 'user', content: `Analyse ce document juridique:\n\nFichier: ${filename}\n\n${text.slice(0, 8000)}` }]
    });
    let raw = result.content[0].text.trim();
    // Strip markdown code fences if present
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const parsed = JSON.parse(raw);
      res.json(parsed);
    } catch {
      res.json({
        score: 70,
        scoreLabel: 'Analyse indicative',
        clauses: [],
        risks: [{ text: 'Analyse automatique non disponible pour ce format.', severity: 'low' }],
        recommendations: ['Consultez un professionnel pour une analyse complète.'],
        summary: 'Analyse du document non disponible — format non supporté ou contenu insuffisant.'
      });
    }
  } catch (err) {
    console.error('Analyze AI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/improve  (JWT requis)
 * Body : { text: string, mode: 'improve'|'correct'|'summarize' }
 * Réponse : { result: string }
 */
app.post('/api/improve', requireAuth, async (req, res) => {
  const { text, mode = 'improve' } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Texte requis.' });

  const prompts = {
    improve: `Améliore le style rédactionnel de ce texte juridique en le rendant plus professionnel, précis et complet. Retourne le texte amélioré avec des commentaires entre [[commentaire: ...]]:\n\n${text}`,
    correct: `Corrige les erreurs de fond juridique, de forme et de style dans ce texte. Signale chaque correction avec [CORRECTION: description]. Retourne le texte corrigé:\n\n${text}`,
    summarize: `Résume ce document juridique en identifiant: les parties, l'objet principal, les obligations clés, les clauses importantes, les risques. Format: sections avec titres en **gras**:\n\n${text}`,
  };

  const userPrompt = prompts[mode] || prompts.improve;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      system: "Tu es un expert en rédaction juridique française. Tu améliores, corriges et synthétises les textes juridiques. Réponds toujours en français.",
      messages: [{ role: 'user', content: userPrompt }]
    });
    res.json({ result: result.content[0].text });
  } catch (err) {
    console.error('Improve AI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /create-payment-intent
 * Corps : { offer: 'unit' | 'pack' | 'sub', currency?: 'eur' | 'xof' }
 * Réponse : { clientSecret }
 */
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { offer = 'unit', currency = 'eur' } = req.body;

    if (!PRICES[offer]) {
      return res.status(400).json({ error: `Offre inconnue : ${offer}` });
    }

    const amount = PRICES[offer];

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: currency.toLowerCase(),
      automatic_payment_methods: { enabled: true },
      metadata: { offer, product: 'legaldraft-ai' },
    });

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /create-subscription
 * Corps : { paymentMethodId, email, priceId? }
 * Crée un client + abonnement Stripe récurrent
 */
app.post('/create-subscription', async (req, res) => {
  try {
    const { paymentMethodId, email } = req.body;

    if (!paymentMethodId || !email) {
      return res.status(400).json({ error: 'paymentMethodId et email requis.' });
    }

    // 1) Créer ou retrouver le client
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId },
        metadata: { product: 'legaldraft-ai' },
      });
    }

    // 2) Attacher le moyen de paiement
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id }).catch(() => {});

    // 3) Créer l'abonnement
    // ⚠️ Remplacez PRICE_ID par l'ID du prix mensuel créé dans votre Dashboard Stripe
    const priceId = process.env.STRIPE_SUBSCRIPTION_PRICE_ID || req.body.priceId;

    if (!priceId) {
      return res.status(400).json({ error: 'STRIPE_SUBSCRIPTION_PRICE_ID manquant dans .env' });
    }

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    const invoice = subscription.latest_invoice;
    const pi      = invoice.payment_intent;

    res.json({
      subscriptionId: subscription.id,
      clientSecret:   pi ? pi.client_secret : null,
      status:         subscription.status,
    });

  } catch (err) {
    console.error('Subscription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhook
 * Écoute les événements Stripe (paiement confirmé, remboursement, etc.)
 * À brancher dans le Dashboard Stripe → Webhooks
 */
app.post('/webhook', (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Gérez ici les événements utiles ──────────────────────────────────────
  switch (event.type) {

    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      console.log(`✅ Paiement réussi : ${pi.id} — ${pi.amount / 100} ${pi.currency.toUpperCase()}`);
      // TODO: enregistrer en base de données, envoyer un email de confirmation, etc.
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.warn(`❌ Paiement échoué : ${pi.id}`);
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      console.log(`🔄 Abonnement ${event.type} : ${sub.id} — statut : ${sub.status}`);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      console.log(`🚫 Abonnement annulé : ${sub.id}`);
      // TODO: révoquer l'accès utilisateur
      break;
    }

    case 'invoice.payment_succeeded': {
      const inv = event.data.object;
      console.log(`🧾 Facture payée : ${inv.id}`);
      break;
    }

    default:
      // Événement non géré — silencieux
      break;
  }

  res.json({ received: true });
});

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 LegalDraft AI — Backend démarré`);
  console.log(`   URL locale  : http://localhost:${PORT}`);
  console.log(`   Santé       : GET  /health`);
  console.log(`   Paiement    : POST /create-payment-intent`);
  console.log(`   Abonnement  : POST /create-subscription`);
  console.log(`   Webhook     : POST /webhook\n`);
});
