/**
 * LegalDraft AI — Backend Node.js
 * Auth utilisateur (JWT) · Free doc unique · Paiements Stripe
 *
 * Stack : Express · bcryptjs · jsonwebtoken · Stripe · CORS · dotenv
 */

require('dotenv').config();

// ── Crash handlers (empêche les exits silencieux) ──────────────────────────
process.on('uncaughtException',  (err) => console.error('💥 uncaughtException:', err.stack || err));
process.on('unhandledRejection', (err) => console.error('💥 unhandledRejection:', err?.stack || err));

const express  = require('express');

// ── Sentry Error Monitoring (lazy — ne crash pas si absent) ──
let Sentry = null;
try {
  if (process.env.SENTRY_DSN) {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'production',
      tracesSampleRate: 0.1,
    });
    console.log('✅ Sentry initialisé');
  } else {
    console.warn('⚠️  SENTRY_DSN manquant — monitoring désactivé');
  }
} catch(e) {
  console.warn('⚠️  Sentry indisponible (package manquant):', e.message);
  Sentry = null;
}

const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('./db');

// Stripe — initialisation défensive (ne crash pas si la clé est absente au démarrage)
let stripe;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialisé');
  } else {
    console.warn('⚠️  STRIPE_SECRET_KEY manquant — paiements désactivés');
    stripe = { paymentIntents: { create: async () => { throw new Error('Stripe non configuré'); } },
               subscriptions:  { create: async () => { throw new Error('Stripe non configuré'); } },
               webhooks:       { constructEvent: () => { throw new Error('Stripe non configuré'); } } };
  }
} catch (e) {
  console.error('❌ Stripe init error:', e.message);
  stripe = { paymentIntents: { create: async () => { throw new Error('Stripe non configuré'); } },
             subscriptions:  { create: async () => { throw new Error('Stripe non configuré'); } },
             webhooks:       { constructEvent: () => { throw new Error('Stripe non configuré'); } } };
}

// ── Email (Resend) ──────────────────────────────────────
let resendClient = null;
try {
  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
    console.log('✅ Resend email initialisé');
  } else {
    console.warn('⚠️  RESEND_API_KEY manquant — emails désactivés');
  }
} catch(e) {
  console.warn('⚠️  Resend indisponible:', e.message);
}

async function sendEmail({ to, subject, html }) {
  if (!resendClient) return;
  try {
    // from: domaine à vérifier sur resend.com → utilise onboarding@resend.dev en attendant
    const fromAddr = process.env.RESEND_FROM || 'LegalDraft AI <onboarding@resend.dev>';
    await resendClient.emails.send({
      from: fromAddr,
      to, subject, html
    });
  } catch(e) {
    console.error('Email error:', e.message);
  }
}

// ── Séquence onboarding J+1 ─────────────────────────────────────────────────
async function sendActivationEmail(userEmail) {
  await sendEmail({
    to: userEmail,
    subject: '⚡ Avez-vous essayé votre premier document ?',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
        <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
          <h1 style="color:#f5c842;margin:0;font-size:1.4rem;">⚖️ LegalDraft AI</h1>
        </div>
        <h2 style="color:#1e293b;font-size:1.2rem;">Votre document gratuit vous attend</h2>
        <p style="color:#475569;">Bonjour,</p>
        <p style="color:#475569;">Vous avez créé votre compte hier — avez-vous eu le temps de générer votre premier document ?</p>
        <p style="color:#475569;">En <strong>60 secondes</strong>, vous pouvez créer :</p>
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;">
          <div style="margin-bottom:8px;">📄 <strong>Un CDI complet</strong> avec toutes les clauses légales</div>
          <div style="margin-bottom:8px;">📧 <strong>Une mise en demeure</strong> prête à envoyer</div>
          <div style="margin-bottom:8px;">🧮 <strong>Un calcul d'indemnité</strong> de licenciement précis</div>
          <div>🤖 <strong>Une analyse de contrat</strong> avec score de conformité</div>
        </div>
        <a href="https://cute-bombolone-d4793a.netlify.app" style="display:inline-block;background:#f5c842;color:#1e293b;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;font-size:1rem;">
          Générer mon document gratuit →
        </a>
        <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;">Des questions ? Répondez directement à cet email.</p>
      </div>
    `
  });
}

// ── Séquence onboarding J+3 ─────────────────────────────────────────────────
async function sendValueEmail(userEmail) {
  await sendEmail({
    to: userEmail,
    subject: '💡 5 façons d\'utiliser LegalDraft AI cette semaine',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
        <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
          <h1 style="color:#f5c842;margin:0;font-size:1.4rem;">⚖️ LegalDraft AI</h1>
        </div>
        <h2 style="color:#1e293b;font-size:1.2rem;">Ce que vous pouvez faire dès maintenant</h2>
        <div style="background:#fff;border-radius:8px;padding:8px;margin:16px 0;">
          <div style="border-left:3px solid #f5c842;padding:12px 16px;margin-bottom:8px;">
            <strong style="color:#1e293b;">1. Vérifier votre conformité RGPD</strong>
            <p style="color:#64748b;margin:4px 0 0;font-size:.85rem;">Générez vos mentions légales et CGV en 2 minutes — obligatoire si vous avez un site.</p>
          </div>
          <div style="border-left:3px solid #f5c842;padding:12px 16px;margin-bottom:8px;">
            <strong style="color:#1e293b;">2. Calculer votre préavis ou indemnité</strong>
            <p style="color:#64748b;margin:4px 0 0;font-size:.85rem;">Rupture conventionnelle, licenciement, heures sup — les montants légaux exacts.</p>
          </div>
          <div style="border-left:3px solid #f5c842;padding:12px 16px;margin-bottom:8px;">
            <strong style="color:#1e293b;">3. Rédiger un NDA avant votre prochain RDV</strong>
            <p style="color:#64748b;margin:4px 0 0;font-size:.85rem;">Accord de confidentialité professionnel en 90 secondes, prêt à faire signer.</p>
          </div>
          <div style="border-left:3px solid #f5c842;padding:12px 16px;margin-bottom:8px;">
            <strong style="color:#1e293b;">4. Analyser un contrat avant de signer</strong>
            <p style="color:#64748b;margin:4px 0 0;font-size:.85rem;">Uploadez le PDF — l'IA identifie les clauses risquées en 30 secondes.</p>
          </div>
          <div style="border-left:3px solid #f5c842;padding:12px 16px;">
            <strong style="color:#1e293b;">5. Comparer les formes juridiques pour votre projet</strong>
            <p style="color:#64748b;margin:4px 0 0;font-size:.85rem;">SAS vs SARL vs SASU — 9 critères comparés côte à côte, droit français et OHADA.</p>
          </div>
        </div>
        <a href="https://cute-bombolone-d4793a.netlify.app" style="display:inline-block;background:#1e293b;color:#f5c842;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;font-size:1rem;">
          Accéder à ma plateforme →
        </a>
        <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;">LegalDraft AI — Documents juridiques en 2 minutes. Droit français &amp; OHADA.</p>
      </div>
    `
  });
}

// ── Séquence onboarding J+7 — conversion payante ────────────────────────────
async function sendConversionEmail(userEmail) {
  await sendEmail({
    to: userEmail,
    subject: '🚀 Passez illimité — offre de lancement',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
        <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
          <h1 style="color:#f5c842;margin:0;font-size:1.4rem;">⚖️ LegalDraft AI</h1>
        </div>
        <h2 style="color:#1e293b;font-size:1.2rem;">Votre document gratuit a été utilisé</h2>
        <p style="color:#475569;">Pour continuer à générer des documents sans limite, découvrez nos offres :</p>
        <div style="background:#fff;border:2px solid #f5c842;border-radius:12px;padding:20px;margin:16px 0;text-align:center;">
          <div style="font-size:.7rem;font-weight:700;color:#1d4ed8;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px;">Le plus populaire</div>
          <div style="font-size:1.8rem;font-weight:800;color:#1e293b;">9€ <span style="font-size:.9rem;font-weight:400;color:#64748b;">/ document</span></div>
          <div style="color:#64748b;font-size:.85rem;margin:8px 0 16px;">Ou <strong>25€ le pack 5 documents</strong> — économisez 20€</div>
          <a href="https://cute-bombolone-d4793a.netlify.app" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Acheter maintenant →</a>
        </div>
        <div style="background:#1e293b;border-radius:12px;padding:20px;margin:16px 0;text-align:center;">
          <div style="font-size:.7rem;font-weight:700;color:#f5c842;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px;">Espace Pro — Avocats &amp; Juristes</div>
          <div style="font-size:1.8rem;font-weight:800;color:#fff;">99€<span style="font-size:.9rem;font-weight:400;color:#94a3b8;">/mois</span></div>
          <div style="color:#94a3b8;font-size:.85rem;margin:8px 0 4px;">Usage illimité · Actes de procédure · Conventions collectives</div>
          <div style="color:#64748b;font-size:.75rem;margin-bottom:16px;">7 jours gratuits — aucune CB requise</div>
          <a href="https://cute-bombolone-d4793a.netlify.app" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Démarrer l'essai gratuit →</a>
        </div>
        <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;text-align:center;">Des questions ? Écrivez-nous à <a href="mailto:contact@legaldraft.ai" style="color:#f5c842;">contact@legaldraft.ai</a></p>
      </div>
    `
  });
}

async function sendTrialExpiryEmail(userEmail, daysLeft) {
  if (daysLeft !== 2 && daysLeft !== 1) return;
  await sendEmail({
    to: userEmail,
    subject: daysLeft === 2 ? '⏰ Votre essai LegalDraft AI expire dans 2 jours' : '🚨 Dernière chance — votre essai expire demain',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
        <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
          <h1 style="color:#f5c842;margin:0;">⚖️ LegalDraft AI</h1>
        </div>
        <h2 style="color:#1e293b;">Votre essai expire ${daysLeft === 1 ? 'demain' : 'dans 2 jours'}</h2>
        <p style="color:#475569;">Votre accès Pro gratuit se termine bientôt. Pour continuer à bénéficier de toutes les fonctionnalités, souscrivez à l'Espace Pro.</p>
        <a href="https://cute-bombolone-d4793a.netlify.app" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;">
          Continuer avec LegalDraft Pro →
        </a>
        <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;">Vous pouvez annuler à tout moment depuis votre espace.</p>
      </div>
    `
  });
}

const app        = express();
const PORT       = process.env.PORT || 4242;
const JWT_SECRET = process.env.JWT_SECRET || 'ld-dev-secret-CHANGE-IN-PROD';
const JWT_EXPIRY = '30d';
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'ld-admin-dev';

// ── MIDDLEWARE ───────────────────────────────────────────────────────────────
// Nettoie FRONTEND_URL des éventuels guillemets/espaces parasites
const _rawOrigin = process.env.FRONTEND_URL || '';
const CORS_ORIGIN = _rawOrigin.replace(/['"]/g, '').trim() || '*';
app.use(cors({
  origin:  CORS_ORIGIN,
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

  if (await db.getUserByEmail(emailClean))
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await db.createUser(emailClean, hash);
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    console.log(`✅ Nouveau compte : ${user.email}`);
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, freeDocUsed: user.free_doc_used },
    });

    // Email de bienvenue
    sendEmail({
      to: email,
      subject: 'Bienvenue sur LegalDraft AI 🎉',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
          <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
            <h1 style="color:#f5c842;margin:0;font-size:1.5rem;">⚖️ LegalDraft AI</h1>
            <p style="color:#94a3b8;margin:8px 0 0;font-size:0.85rem;">Intelligence Juridique</p>
          </div>
          <h2 style="color:#1e293b;">Bienvenue ${email} !</h2>
          <p style="color:#475569;">Votre compte LegalDraft AI a été créé avec succès.</p>
          <p style="color:#475569;">Vous pouvez maintenant accéder à la plateforme et générer vos premiers documents juridiques.</p>
          <a href="https://cute-bombolone-d4793a.netlify.app" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;">
            Accéder à la plateforme →
          </a>
          <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;">LegalDraft AI — Droit français & OHADA. Les documents générés sont des modèles indicatifs.</p>
        </div>
      `
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

  const user = await db.getUserByEmail(email);
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
app.get('/auth/me', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
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
app.get('/free-doc/status', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.user.id);
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
app.post('/free-doc/claim', requireAuth, async (req, res) => {
  const { docType = 'non renseigné' } = req.body || {};
  const user = await db.getUserById(req.user.id);

  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  if (!db.canUseFreeDocument(user)) {
    console.warn(`⚠️  Free doc déjà utilisé — tentative : ${user.email}`);
    return res.status(403).json({
      error: 'Vous avez déjà utilisé votre document gratuit.',
      code:  'FREE_DOC_ALREADY_USED',
    });
  }

  try {
    await db.markFreeDocumentAsUsed(user.id, docType);
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
app.get('/admin/free-doc-usage', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY)
    return res.status(403).json({ error: 'Accès refusé.' });

  const users = await db.getAllUsers();
  const log   = await db.getFreeDocLog();

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

// Sentry error handler
if (Sentry && process.env.SENTRY_DSN) {
  try { Sentry.setupExpressErrorHandler(app); } catch(e) {}
}

/**
 * POST /api/send-trial-warning
 * Envoie un email J+5 à un utilisateur en essai Pro (2 jours restants).
 * Appelé depuis le frontend quand trialData.endDate - now() <= 48h ET pas encore envoyé.
 * Body: { email, firstName?, daysLeft }
 */
app.post('/api/send-trial-warning', requireAuth, async (req, res) => {
  const { email, firstName, daysLeft } = req.body;
  if (!email) return res.status(400).json({ error: 'email requis' });

  const name = firstName || 'vous';
  const days = typeof daysLeft === 'number' ? daysLeft : 2;

  try {
    await sendEmail({
      to: email,
      subject: `⏳ Il vous reste ${days} jour${days > 1 ? 's' : ''} d'essai Pro — agissez maintenant`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
          <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
            <h1 style="color:#f5c842;margin:0;font-size:1.4rem;">⚖️ LegalDraft AI</h1>
          </div>

          <h2 style="color:#1e293b;font-size:1.2rem;">⏳ Votre essai Pro se termine dans ${days} jour${days > 1 ? 's' : ''}</h2>
          <p style="color:#475569;">Bonjour ${name},</p>
          <p style="color:#475569;">Votre période d'essai Pro expire bientôt. Après cette date, vous perdrez l'accès à :</p>

          <ul style="color:#475569;line-height:1.8;">
            <li>📄 Génération illimitée de documents</li>
            <li>⚖️ Actes OHADA et droit international</li>
            <li>🤖 Assistant juridique IA</li>
            <li>📊 Calculateurs avancés (préavis, indemnités)</li>
            <li>🔒 Coffre-fort sécurisé de documents</li>
          </ul>

          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:24px 0;">
            <p style="color:#1d4ed8;margin:0;font-weight:600;">💡 Continuez sans interruption</p>
            <p style="color:#3b82f6;margin:8px 0 0;">Souscrivez maintenant et conservez tous vos documents générés pendant l'essai.</p>
          </div>

          <div style="text-align:center;margin:32px 0;">
            <a href="https://legaldraft.fr" style="display:inline-block;background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">
              Continuer avec Pro →
            </a>
          </div>

          <p style="color:#94a3b8;font-size:0.8rem;text-align:center;">
            Sans engagement · Annulation en 1 clic · Support inclus<br>
            <a href="https://legaldraft.fr" style="color:#94a3b8;">legaldraft.fr</a>
          </p>
        </div>
      `
    });

    res.json({ ok: true, message: `Email trial warning envoyé à ${email}` });
  } catch (err) {
    console.error('send-trial-warning error:', err.message);
    res.status(500).json({ error: 'Échec envoi email' });
  }
});

// ── GESTIONNAIRE D'ERREUR GLOBAL ──────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('❌ Express error handler:', err.stack || err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erreur interne du serveur.' });
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
