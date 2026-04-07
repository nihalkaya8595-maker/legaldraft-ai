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
const crypto   = require('crypto');
const db       = require('./db');

// Stripe — initialisation défensive (ne crash pas si la clé est absente au démarrage)
let stripe;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialisé');
    if (!process.env.STRIPE_WEBHOOK_SECRET)
      console.warn('⚠️  STRIPE_WEBHOOK_SECRET manquant — webhooks désactivés (ajoutez-le dans Railway)');
    if (!process.env.STRIPE_SUBSCRIPTION_PRICE_ID)
      console.warn('⚠️  STRIPE_SUBSCRIPTION_PRICE_ID manquant — abonnements mensuels désactivés');
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

// ── Claude AI helper ────────────────────────────────────
// Model routing: Sonnet for standard tasks (5× cheaper), Opus for complex analysis only
const CLAUDE_SONNET = 'claude-3-5-sonnet-20241022'; // $3/$15 per 1M tokens
const CLAUDE_OPUS   = 'claude-opus-4-5';            // $15/$75 — use sparingly

async function callClaude(system, prompt, maxTokens = 1024, useOpus = false) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = useOpus ? CLAUDE_OPUS : CLAUDE_SONNET;
  const result = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }]
  });
  return result.content[0].text;
}

// Simple RSS parser (no external deps)
function parseRSSItems(xml) {
  const items = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of blocks.slice(0, 8)) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = get('title');
    const summary = get('description').slice(0, 220);
    const link = get('link') || get('guid');
    const date = get('pubDate');
    if (title) items.push({ title, summary, link, date, cat: 'affaires' });
  }
  return items;
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
        <a href="https://legaldraft.fr" style="display:inline-block;background:#f5c842;color:#1e293b;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;font-size:1rem;">
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
        <a href="https://legaldraft.fr" style="display:inline-block;background:#1e293b;color:#f5c842;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;font-size:1rem;">
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
          <a href="https://legaldraft.fr" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Acheter maintenant →</a>
        </div>
        <div style="background:#1e293b;border-radius:12px;padding:20px;margin:16px 0;text-align:center;">
          <div style="font-size:.7rem;font-weight:700;color:#f5c842;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px;">Espace Pro — Avocats &amp; Juristes</div>
          <div style="font-size:1.8rem;font-weight:800;color:#fff;">99€<span style="font-size:.9rem;font-weight:400;color:#94a3b8;">/mois</span></div>
          <div style="color:#94a3b8;font-size:.85rem;margin:8px 0 4px;">Usage illimité · Actes de procédure · Conventions collectives</div>
          <div style="color:#64748b;font-size:.75rem;margin-bottom:16px;">7 jours gratuits — aucune CB requise</div>
          <a href="https://legaldraft.fr" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">Démarrer l'essai gratuit →</a>
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
        <a href="https://legaldraft.fr" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;">
          Continuer avec LegalDraft Pro →
        </a>
        <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;">Vous pouvez annuler à tout moment depuis votre espace.</p>
      </div>
    `
  });
}

// ── Email confirmation paiement ──────────────────────────────────────────────
async function sendPaymentConfirmEmail(userEmail, { amount, plan, invoiceUrl }) {
  const planLabels = { pack:'Pack 5 documents', monthly:'Abonnement mensuel Pro', pro:'Espace Pro', cabinet:'Plan Cabinet' };
  const label = planLabels[plan] || plan;
  await sendEmail({
    to: userEmail,
    subject: '✅ Paiement confirmé — LegalDraft AI',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
        <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
          <h1 style="color:#f5c842;margin:0;font-size:1.5rem;">⚖️ LegalDraft AI</h1>
        </div>
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:20px;margin-bottom:20px;">
          <h2 style="color:#15803d;margin:0 0 8px;">✅ Paiement confirmé</h2>
          <p style="color:#166534;margin:0;">Merci pour votre achat. Votre accès est immédiatement actif.</p>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
          <tr><td style="padding:8px;color:#64748b;font-size:.85rem;">Plan</td><td style="padding:8px;font-weight:600;">${label}</td></tr>
          <tr style="background:#f8fafc;"><td style="padding:8px;color:#64748b;font-size:.85rem;">Montant</td><td style="padding:8px;font-weight:600;">${(amount/100).toFixed(2)} €</td></tr>
        </table>
        ${invoiceUrl ? `<a href="${invoiceUrl}" style="display:inline-block;background:#1e293b;color:#f5c842;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.85rem;margin-bottom:16px;">📄 Voir la facture →</a>` : ''}
        <a href="https://legaldraft.fr" style="display:block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;text-align:center;">
          Accéder à LegalDraft AI →
        </a>
        <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;">LegalDraft AI — Questions ? Répondez à cet email.</p>
      </div>
    `
  });
}

async function sendPaymentFailedEmail(userEmail) {
  await sendEmail({
    to: userEmail,
    subject: '⚠️ Problème de paiement — LegalDraft AI',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
        <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
          <h1 style="color:#f5c842;margin:0;font-size:1.5rem;">⚖️ LegalDraft AI</h1>
        </div>
        <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:20px;margin-bottom:20px;">
          <h2 style="color:#dc2626;margin:0 0 8px;">⚠️ Paiement non abouti</h2>
          <p style="color:#991b1b;margin:0;">Votre paiement n'a pas pu être traité. Aucun débit n'a été effectué.</p>
        </div>
        <p style="color:#475569;">Vérifiez vos informations de carte bancaire et réessayez depuis la plateforme.</p>
        <a href="https://legaldraft.fr" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;">
          Réessayer →
        </a>
        <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;">LegalDraft AI — Si le problème persiste, contactez-nous.</p>
      </div>
    `
  });
}

async function sendSubscriptionCancelledEmail(userEmail) {
  await sendEmail({
    to: userEmail,
    subject: '💤 Abonnement annulé — LegalDraft AI',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
        <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
          <h1 style="color:#f5c842;margin:0;font-size:1.5rem;">⚖️ LegalDraft AI</h1>
        </div>
        <h2 style="color:#1e293b;">Votre abonnement est annulé</h2>
        <p style="color:#475569;">Votre abonnement LegalDraft AI a bien été annulé. Votre accès reste actif jusqu'à la fin de la période payée.</p>
        <p style="color:#475569;">Vous pouvez vous réabonner à tout moment.</p>
        <a href="https://legaldraft.fr" style="display:inline-block;background:#f5c842;color:#1e293b;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;">
          Revenir sur LegalDraft AI →
        </a>
        <p style="color:#94a3b8;font-size:0.75rem;margin-top:24px;">LegalDraft AI — Nous espérons vous revoir bientôt.</p>
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
// Origines autorisées : FRONTEND_URL (env) + domaines fixes legaldraft.fr
const _rawOrigin = (process.env.FRONTEND_URL || '').replace(/['"]/g, '').trim();
const ALLOWED_ORIGINS = new Set([
  'https://legaldraft.fr',
  'https://www.legaldraft.fr',
  ..._rawOrigin ? _rawOrigin.split(',').map(o => o.trim()).filter(Boolean) : [],
]);
app.use(cors({
  origin: (origin, cb) => {
    // Autoriser les requêtes sans origin (Postman, curl, mobile)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    // Autoriser localhost en dev
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error(`CORS: origin non autorisée — ${origin}`));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
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
// Plan unit supprimé — seul le 99€/mois existe.
const PRICES = {
  pack: 2500,    // 25,00 € — pack 5 docs (optionnel futur)
  sub:  9900,    // 99,00 € — abonnement mensuel (NOTE: /create-subscription utilise
                 //           STRIPE_SUBSCRIPTION_PRICE_ID depuis .env)
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

    // Génération du token de vérification email
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await db.setVerificationToken(user.id, verifyToken);
    const verifyUrl = `https://legaldraft-ai-production.up.railway.app/auth/verify-email?token=${verifyToken}`;

    console.log(`✅ Nouveau compte : ${user.email}`);
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, freeDocUsed: user.free_doc_used },
    });

    // Email de bienvenue (J+0) + lien de vérification
    sendEmail({
      to: email,
      subject: 'Bienvenue sur LegalDraft AI 🎉 — Confirmez votre email',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f8fafc;">
          <div style="background:#1e293b;padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
            <h1 style="color:#f5c842;margin:0;font-size:1.5rem;">⚖️ LegalDraft AI</h1>
            <p style="color:#94a3b8;margin:8px 0 0;font-size:0.85rem;">Intelligence Juridique</p>
          </div>
          <h2 style="color:#1e293b;">Bienvenue ${email} !</h2>
          <p style="color:#475569;">Votre compte LegalDraft AI a été créé avec succès. Une dernière étape : confirmez votre adresse email.</p>
          <div style="background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:16px;margin:16px 0;">
            <p style="color:#713f12;margin:0;font-size:0.9rem;">📧 Cliquez sur le bouton ci-dessous pour vérifier votre adresse email et activer pleinement votre compte.</p>
          </div>
          <a href="${verifyUrl}" style="display:inline-block;background:#f5c842;color:#1e293b;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:16px 0;font-size:1rem;">
            ✅ Confirmer mon email →
          </a>
          <p style="color:#94a3b8;font-size:0.8rem;margin-top:8px;">Ce lien est valide 7 jours. Si vous n'avez pas créé de compte, ignorez cet email.</p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
          <p style="color:#94a3b8;font-size:0.75rem;">LegalDraft AI — Droit français & OHADA. Les documents générés sont des modèles indicatifs.</p>
        </div>
      `
    });

    // Séquence onboarding — fire & forget (annulée si redémarrage serveur)
    setTimeout(() => sendActivationEmail(emailClean), 24 * 3600 * 1000);       // J+1
    setTimeout(() => sendValueEmail(emailClean),      3  * 24 * 3600 * 1000);  // J+3
    setTimeout(() => sendConversionEmail(emailClean), 7  * 24 * 3600 * 1000);  // J+7
    console.log(`📧 Séquence onboarding planifiée pour ${emailClean} (J+1, J+3, J+7)`);
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Erreur serveur — réessayez.' });
  }
});

/**
 * GET /auth/verify-email?token=xxx
 * Confirme l'email → redirige vers https://legaldraft.fr?email_verified=1
 */
app.get('/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('https://legaldraft.fr?email_verified=error');
  try {
    const user = await db.getUserByVerificationToken(token);
    if (!user) return res.redirect('https://legaldraft.fr?email_verified=invalid');
    await db.markEmailVerified(user.id);
    console.log(`✅ Email vérifié : ${user.email}`);
    return res.redirect('https://legaldraft.fr?email_verified=1');
  } catch (err) {
    console.error('Verify email error:', err.message);
    return res.redirect('https://legaldraft.fr?email_verified=error');
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
    profile:         user.profile || null,
  });
});

/**
 * PATCH /api/me/profile
 * Met à jour le profil utilisateur (avocat, rh, juriste, ohada).
 * Body: { profile: string }
 */
app.patch('/api/me/profile', requireAuth, async (req, res) => {
  const { profile } = req.body;
  const ALLOWED = ['avocat', 'rh', 'juriste', 'ohada'];
  if (!profile || !ALLOWED.includes(profile)) return res.status(400).json({ error: 'Profil invalide' });
  try {
    await db.updateUserProfile(req.user.id, profile);
    res.json({ ok: true, profile });
  } catch (err) {
    console.error('PATCH /api/me/profile error:', err.message);
    res.status(500).json({ error: 'Erreur mise à jour profil' });
  }
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
 * GET /api/veille
 * Récupère les actualités juridiques depuis RSS (Village de la Justice) + cache 6h.
 * Fallback : Claude génère des actualités si RSS indisponible.
 */
app.get('/api/veille', async (req, res) => {
  const cacheKey = 'veille_juridique_v2';
  try {
    const cached = await db.getCached(cacheKey);
    if (cached) return res.json(JSON.parse(cached));
  } catch {}

  // Sources RSS multiples — on essaie dans l'ordre jusqu'à en trouver une qui répond
  const RSS_SOURCES = [
    { url: 'https://www.village-justice.com/articles/RSS-flux,2.html', name: 'Village de la Justice' },
    { url: 'https://feeds.feedburner.com/LegaVox', name: 'LegaVox' },
    { url: 'https://www.dalloz-actualite.fr/rss.xml', name: 'Dalloz Actualité' },
  ];

  for (const source of RSS_SOURCES) {
    try {
      const rssRes = await fetch(source.url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'LegalDraftAI/1.0 (+https://legaldraft.fr)', 'Accept': 'application/rss+xml, application/xml, text/xml' }
      });
      if (!rssRes.ok) { console.warn(`RSS ${source.name}: HTTP ${rssRes.status}`); continue; }
      const xml = await rssRes.text();
      const items = parseRSSItems(xml);
      if (!items.length) { console.warn(`RSS ${source.name}: empty items`); continue; }

      const result = { items: items.slice(0, 10), source: source.name, fetchedAt: new Date().toISOString() };
      db.setCached(cacheKey, JSON.stringify(result), 6).catch(() => {});
      console.log(`✅ Veille RSS ok: ${source.name} (${items.length} items)`);
      return res.json(result);
    } catch (e) {
      console.warn(`RSS ${source.name} failed:`, e.message);
    }
  }

  // Fallback Claude AI — génère des actualités si tous les RSS échouent
  console.warn('All RSS sources failed — using Claude AI fallback');
  try {
    const year = new Date().getFullYear();
    const month = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const raw = await callClaude(
      'Tu es un expert en actualité juridique française et OHADA. Réponds uniquement en JSON valide, sans markdown ni texte avant/après.',
      `Génère 8 actualités juridiques importantes et récentes (${month}) en droit français et OHADA.
Retourne UNIQUEMENT ce JSON: [{"title":"...","summary":"résumé en 2-3 phrases concises...","cat":"travail|affaires|rgpd|fiscal|ohada|procédure","date":"${month}","link":""}]`,
      2000
    );
    let items;
    try { items = JSON.parse(raw.trim().replace(/^```json?\s*/i,'').replace(/\s*```$/,'')); }
    catch { console.error('Claude veille JSON parse failed'); items = []; }

    if (!items.length) throw new Error('Claude returned no items');
    const result = { items, source: 'LegalDraft IA', fetchedAt: new Date().toISOString() };
    db.setCached(cacheKey, JSON.stringify(result), 3).catch(() => {});
    return res.json(result);
  } catch (aiErr) {
    console.error('Veille AI fallback error:', aiErr.message);
    // Dernier recours : actualités statiques hard-codées pour ne jamais afficher d'erreur
    const year = new Date().getFullYear();
    const staticItems = [
      { title: 'Réforme du droit des contrats : bilan et perspectives', summary: 'L\'ordonnance de 2016 portant réforme du droit des contrats continue de produire ses effets. Les tribunaux consolident leur jurisprudence sur les nouvelles dispositions relatives à la formation et à l\'exécution des contrats.', cat: 'affaires', date: `${year}`, link: '' },
      { title: 'RGPD : nouvelles lignes directrices de la CNIL', summary: 'La CNIL publie de nouvelles recommandations sur la collecte des données personnelles et le consentement des utilisateurs dans le cadre de la mise en conformité des entreprises.', cat: 'rgpd', date: `${year}`, link: '' },
      { title: 'Droit du travail : actualités sur le télétravail', summary: 'Les règles encadrant le télétravail évoluent. Employeurs et salariés doivent adapter leurs accords collectifs aux nouvelles exigences légales et conventionnelles.', cat: 'travail', date: `${year}`, link: '' },
      { title: 'OHADA : révision de l\'Acte Uniforme sur les sociétés commerciales', summary: 'L\'Organisation pour l\'Harmonisation en Afrique du Droit des Affaires poursuit sa modernisation. Les nouvelles dispositions impactent la création et la gouvernance des sociétés dans les États membres.', cat: 'ohada', date: `${year}`, link: '' },
      { title: 'Bail commercial : jurisprudence récente sur le loyer', summary: 'La Cour de cassation précise les conditions de révision du loyer commercial et les obligations des parties lors du renouvellement du bail.', cat: 'affaires', date: `${year}`, link: '' },
      { title: 'Fiscalité des entreprises : nouvelles mesures', summary: 'Le gouvernement annonce des ajustements fiscaux affectant les PME et les indépendants. Entreprises et experts-comptables doivent adapter leurs stratégies.', cat: 'fiscal', date: `${year}`, link: '' },
    ];
    return res.json({ items: staticItems, source: 'LegalDraft IA (statique)', fetchedAt: new Date().toISOString() });
  }
});

/**
 * GET /api/dictionnaire/:term
 * Génère une définition juridique IA pour le terme demandé. Cache 7 jours.
 */
app.get('/api/dictionnaire/:term', async (req, res) => {
  const term = (req.params.term || '').trim();
  if (term.length < 2 || term.length > 80) return res.status(400).json({ error: 'Terme invalide' });

  const cacheKey = `dico_${term.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
  try {
    const cached = await db.getCached(cacheKey);
    if (cached) return res.json(JSON.parse(cached));
  } catch {}

  try {
    const raw = await callClaude(
      'Tu es un expert en droit français et droit OHADA. Réponds uniquement en JSON valide, sans markdown.',
      `Définis le terme juridique "${term}" en droit français (et OHADA si applicable).
Retourne UNIQUEMENT ce JSON:
{"term":"${term}","def":"définition complète et précise en 2-3 phrases","ref":"référence légale exacte (article, loi, acte uniforme)","cat":"contrats|travail|societes|procedure|ohada|immobilier|fiscal"}`,
      500
    );
    let parsed;
    try { parsed = JSON.parse(raw.trim().replace(/^```json?\s*/i,'').replace(/\s*```$/,'')); }
    catch { parsed = { term, def: raw.trim(), ref: '', cat: 'contrats' }; }

    db.setCached(cacheKey, JSON.stringify(parsed), 168).catch(() => {}); // 7 jours
    return res.json(parsed);
  } catch (err) {
    console.error('Dictionnaire AI error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/generate-contract  (JWT requis)
 * Body: { type, title, fields: {}, jurisdiction, isOHADA }
 * Génère le corps du contrat (articles) avec Claude AI.
 * Réponse : { content: string }
 */
// ── Fair use tracking (in-memory per period — persisted to DB profile) ──────
// FAIR_USE_MONTHLY_LIMIT : 50 documents IA / mois par utilisateur Pro
const FAIR_USE_MONTHLY_LIMIT = 50;

async function checkAndIncrementFairUse(userId) {
  try {
    const user = await db.getUserById(userId);
    if (!user) return { ok: false, reason: 'user_not_found' };

    // Cabinet plan gets 150 docs/month
    const limit = user.current_plan === 'cabinet' ? 150 : FAIR_USE_MONTHLY_LIMIT;

    const profileRaw = user.profile ? JSON.parse(user.profile) : {};
    const now = new Date();
    const periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const usage = profileRaw.ai_usage || {};

    if (usage.period !== periodKey) {
      // Reset counter for new month
      usage.period = periodKey;
      usage.count = 0;
    }

    if (usage.count >= limit) {
      return { ok: false, reason: 'fair_use_exceeded', count: usage.count, limit };
    }

    usage.count = (usage.count || 0) + 1;
    profileRaw.ai_usage = usage;
    await db.updateUserProfile(userId, JSON.stringify(profileRaw));
    return { ok: true, count: usage.count, limit, remaining: limit - usage.count };
  } catch (e) {
    console.warn('Fair use check error (non-blocking):', e.message);
    return { ok: true }; // Fail open — ne bloque pas en cas d'erreur DB
  }
}

app.post('/api/generate-contract', requireAuth, async (req, res) => {
  const { type, title, fields = {}, jurisdiction = 'France', isOHADA = false } = req.body || {};
  if (!type || !title) return res.status(400).json({ error: 'type et title requis' });

  // ── Fair use check ────────────────────────────────────────────────────────
  const fuCheck = await checkAndIncrementFairUse(req.user.id);
  if (!fuCheck.ok) {
    if (fuCheck.reason === 'fair_use_exceeded') {
      console.warn(`⚠️ Fair use exceeded: user ${req.user.email} (${fuCheck.count}/${fuCheck.limit} docs ce mois)`);
      return res.status(429).json({
        error: 'fair_use_exceeded',
        message: `Limite mensuelle atteinte (${fuCheck.limit} documents IA/mois). Votre compteur se réinitialise le 1er du mois prochain.`,
        count: fuCheck.count,
        limit: fuCheck.limit
      });
    }
  } else {
    console.log(`📊 AI usage: ${req.user.email} — ${fuCheck.count || '?'}/${fuCheck.limit || FAIR_USE_MONTHLY_LIMIT} docs ce mois`);
  }

  const fieldsList = Object.entries(fields)
    .filter(([, val]) => val && val !== '___' && String(val).trim())
    .map(([key, val]) => `- ${key}: ${val}`)
    .join('\n');

  const system = `Tu es un expert juriste spécialisé en ${isOHADA ? 'droit OHADA et droit français' : 'droit français'} (${new Date().getFullYear()}).
Tu génères des contrats juridiques professionnels, complets et conformes au droit en vigueur.
Réponds UNIQUEMENT avec les articles du contrat au format demandé, sans introduction ni conclusion.`;

  const prompt = `Génère les articles d'un "${title}" complet et professionnel.

Informations fournies:
${fieldsList || '(informations génériques)'}
Juridiction: ${isOHADA ? `Droit OHADA — ${jurisdiction}` : `Droit français — ${jurisdiction}`}

Format de sortie OBLIGATOIRE pour chaque article:
ARTICLE N — TITRE EN MAJUSCULES
Contenu rédigé en langage juridique précis...

Exigences:
- 8 à 12 articles selon la complexité du contrat
- Couvrir obligatoirement: objet, obligations des parties, durée, prix/rémunération (si applicable), confidentialité, résiliation, force majeure, loi applicable et juridiction compétente
- Langage juridique professionnel, phrases complètes, style formel
- Commencer DIRECTEMENT par "ARTICLE 1 —" sans aucun texte avant`;

  try {
    const content = await callClaude(system, prompt, 3500);
    console.log(`📄 Contrat IA généré : "${title}" pour ${req.user.email}`);
    res.json({ content });
  } catch (err) {
    console.error('Generate contract AI error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
      model: CLAUDE_SONNET,
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
      model: CLAUDE_SONNET,
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
      model: CLAUDE_SONNET,
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

  // ── Handlers Stripe ──────────────────────────────────────────────────────
  // Tous les handlers sont async — on les fire-and-forget pour répondre 200 immédiatement
  (async () => {
    try {
      switch (event.type) {

        // ── Paiement one-shot confirmé (pack) ─────────────────────────────
        case 'payment_intent.succeeded': {
          const pi     = event.data.object;
          const offer  = pi.metadata?.offer || 'pack'; // seul 'pack' subsiste
          const email  = pi.receipt_email || pi.metadata?.email;
          const amount = pi.amount;
          console.log(`✅ PaymentIntent réussi : ${pi.id} — ${amount/100}€ — offre: ${offer}`);

          // Mettre à jour le plan en DB si on a l'email
          if (email) {
            const user = await db.getUserByEmail(email);
            if (user) {
              const docsMap = { pack: 5 };
              const docs    = docsMap[offer] || 5;
              await db.updateUserPlan(user.id, offer, {
                stripePaymentIntentId: pi.id,
                docsRemaining: docs,
                paidAt: new Date().toISOString(),
              });
              console.log(`📦 Plan "${offer}" (${docs} doc${docs>1?'s':''}) activé pour ${email}`);
            }
            await sendPaymentConfirmEmail(email, { amount, plan: offer, invoiceUrl: null });
          }
          break;
        }

        // ── Paiement échoué ──────────────────────────────────────────────
        case 'payment_intent.payment_failed': {
          const pi    = event.data.object;
          const email = pi.receipt_email || pi.metadata?.email;
          console.warn(`❌ PaymentIntent échoué : ${pi.id} — ${email || 'email inconnu'}`);
          if (email) await sendPaymentFailedEmail(email);
          break;
        }

        // ── Abonnement mensuel créé ou mis à jour ────────────────────────
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub = event.data.object;
          console.log(`🔄 Abonnement ${event.type} : ${sub.id} — statut: ${sub.status}`);
          if (sub.status === 'active' || sub.status === 'trialing') {
            // Retrouver l'utilisateur via le customer Stripe
            const customer = await stripe.customers.retrieve(sub.customer);
            const email    = customer.email;
            if (email) {
              const user = await db.getUserByEmail(email);
              if (user) {
                const expiresAt = new Date(sub.current_period_end * 1000).toISOString();
                await db.updateUserPlan(user.id, 'monthly', {
                  stripeSubscriptionId: sub.id,
                  stripeCustomerId:     sub.customer,
                  expiresAt,
                  monthlyCount: 0,
                  status: sub.status,
                });
                console.log(`📅 Abonnement mensuel activé pour ${email} jusqu'au ${expiresAt}`);
              }
            }
          }
          break;
        }

        // ── Abonnement annulé ────────────────────────────────────────────
        case 'customer.subscription.deleted': {
          const sub      = event.data.object;
          const customer = await stripe.customers.retrieve(sub.customer);
          const email    = customer.email;
          console.log(`🚫 Abonnement annulé : ${sub.id} — ${email || 'email inconnu'}`);
          if (email) {
            const user = await db.getUserByEmail(email);
            if (user) {
              await db.updateUserPlan(user.id, 'none', {
                stripeSubscriptionId: sub.id,
                cancelledAt: new Date().toISOString(),
              });
              console.log(`🔒 Accès révoqué pour ${email}`);
            }
            await sendSubscriptionCancelledEmail(email);
          }
          break;
        }

        // ── Facture payée (renouvellement mensuel) ───────────────────────
        case 'invoice.payment_succeeded': {
          const inv = event.data.object;
          // Uniquement les renouvellements (billing_reason = 'subscription_cycle')
          if (inv.billing_reason === 'subscription_cycle') {
            const email = inv.customer_email;
            console.log(`🔄 Renouvellement mensuel : ${inv.id} — ${email}`);
            if (email) {
              const user = await db.getUserByEmail(email);
              if (user) {
                // Reset du compteur mensuel
                const sub = await stripe.subscriptions.retrieve(inv.subscription);
                const expiresAt = new Date(sub.current_period_end * 1000).toISOString();
                await db.updateUserPlan(user.id, 'monthly', {
                  stripeSubscriptionId: inv.subscription,
                  stripeCustomerId: inv.customer,
                  expiresAt,
                  monthlyCount: 0,
                  renewedAt: new Date().toISOString(),
                });
              }
              await sendPaymentConfirmEmail(email, {
                amount: inv.amount_paid,
                plan: 'monthly',
                invoiceUrl: inv.hosted_invoice_url || null,
              });
            }
          }
          break;
        }

        default:
          // Événement non géré — silencieux
          break;
      }
    } catch (handlerErr) {
      console.error(`Webhook handler error [${event.type}]:`, handlerErr.message);
    }
  })();

  // Répondre immédiatement à Stripe (avant que les handlers async se terminent)
  res.json({ received: true });
});

// Sentry error handler
if (Sentry && process.env.SENTRY_DSN) {
  try { Sentry.setupExpressErrorHandler(app); } catch(e) {}
}

/**
 * GET /api/vault
 * Retourne les documents du coffre-fort de l'utilisateur connecté.
 */
app.get('/api/vault', requireAuth, async (req, res) => {
  try {
    const docs = await db.getVaultDocs(req.user.id);
    res.json({ docs });
  } catch (err) {
    console.error('GET /api/vault error:', err.message);
    res.status(500).json({ error: 'Erreur lecture vault' });
  }
});

/**
 * POST /api/vault
 * Sauvegarde ou met à jour un document dans le coffre-fort.
 * Body: { id, type, typeLabel, content, createdAt, meta }
 */
app.post('/api/vault', requireAuth, async (req, res) => {
  const { id, type, typeLabel, content, createdAt, meta } = req.body;
  if (!id || !type || !content) return res.status(400).json({ error: 'id, type et content requis' });
  try {
    await db.saveVaultDoc(req.user.id, { id, type, typeLabel, content, createdAt, meta });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/vault error:', err.message);
    res.status(500).json({ error: 'Erreur sauvegarde vault' });
  }
});

/**
 * DELETE /api/vault/:docId
 * Supprime un document du coffre-fort.
 */
app.delete('/api/vault/:docId', requireAuth, async (req, res) => {
  try {
    await db.deleteVaultDoc(req.user.id, req.params.docId);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/vault error:', err.message);
    res.status(500).json({ error: 'Erreur suppression vault' });
  }
});

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
