# LegalDraft AI — Guide de déploiement complet

## 📁 Structure des fichiers

```
legaldraft-backend/
├── server.js          ← Backend Node.js (Stripe + Express)
├── frontend.html      ← Interface utilisateur (à héberger séparément)
├── package.json       ← Dépendances Node.js
├── .env.example       ← Modèle de configuration (à copier en .env)
├── .gitignore
└── README.md
```

---

## 🚀 Installation en 5 minutes

### 1. Prérequis
- Node.js 18+ installé → https://nodejs.org
- Un compte Stripe → https://stripe.com

### 2. Installer les dépendances
```bash
cd legaldraft-backend
npm install
```

### 3. Configurer les variables d'environnement
```bash
cp .env.example .env
```
Éditez `.env` avec vos clés Stripe :
```
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
STRIPE_SUBSCRIPTION_PRICE_ID=price_xxxxxxxxxxxx
FRONTEND_URL=http://localhost:3000
```

### 4. Démarrer le serveur
```bash
# Mode production
npm start

# Mode développement (redémarrage automatique)
npm run dev
```

Le backend sera accessible sur → http://localhost:4242

---

## 🔑 Obtenir vos clés Stripe

### Clé secrète (`STRIPE_SECRET_KEY`)
1. Connectez-vous sur https://dashboard.stripe.com
2. Menu → **Développeurs** → **Clés API**
3. Copiez la **Clé secrète** (commence par `sk_test_` ou `sk_live_`)

### Clé publique (dans `frontend.html`)
Même page → copiez la **Clé publiable** (commence par `pk_test_` ou `pk_live_`)
→ Remplacez `STRIPE_PUBLIC_KEY` dans `frontend.html`

### Webhook secret (`STRIPE_WEBHOOK_SECRET`)
```bash
# Installer Stripe CLI
stripe listen --forward-to localhost:4242/webhook
# La CLI affiche le webhook secret : whsec_...
```
En production → Dashboard Stripe → **Développeurs** → **Webhooks** → Ajouter un endpoint

### Price ID abonnement (`STRIPE_SUBSCRIPTION_PRICE_ID`)
1. Dashboard Stripe → **Catalogue de produits** → **Ajouter un produit**
2. Nom : "LegalDraft AI — Abonnement mensuel"
3. Prix : 19,00 € · Récurrent · Mensuel
4. Copiez l'ID du prix (`price_xxxxx`)

---

## 🌐 Déploiement en production

### Option A — Railway (recommandé, gratuit pour démarrer)
```bash
# Installez Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

### Option B — Render
1. https://render.com → New Web Service
2. Connectez votre repo GitHub
3. Build command : `npm install`
4. Start command : `node server.js`
5. Ajoutez les variables d'environnement dans l'interface

### Option C — VPS (DigitalOcean, OVH, etc.)
```bash
# Sur le serveur
git clone https://github.com/votre-repo/legaldraft-backend
cd legaldraft-backend
npm install --production
cp .env.example .env
# Éditez .env avec vos vraies clés

# Avec PM2 pour la persistance
npm install -g pm2
pm2 start server.js --name legaldraft
pm2 save && pm2 startup
```

---

## 🔧 Tester les paiements

### Cartes de test Stripe
| Numéro            | Résultat               |
|-------------------|------------------------|
| 4242 4242 4242 4242 | ✅ Paiement réussi    |
| 4000 0000 0000 0002 | ❌ Carte refusée      |
| 4000 0025 0000 3155 | 🔐 Authentification 3D |

Date d'expiration : n'importe quelle date future (ex: 12/26)
CVC : n'importe quel code à 3 chiffres (ex: 123)

---

## 📡 Endpoints API

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/health` | Vérification du serveur |
| POST | `/create-payment-intent` | Paiement unique (9€ / 29€) |
| POST | `/create-subscription` | Abonnement mensuel (19€/mois) |
| POST | `/webhook` | Événements Stripe |

### Exemple d'appel `/create-payment-intent`
```json
POST /create-payment-intent
{
  "offer": "unit",
  "currency": "eur"
}
→ { "clientSecret": "pi_xxx_secret_xxx" }
```

---

## 💰 Récapitulatif des revenus attendus

| Offre | Prix | 100 clients/mois | 500 clients/mois |
|-------|------|-----------------|-----------------|
| Unitaire | 9 € | 900 € | 4 500 € |
| Pack | 29 € | 2 900 € | 14 500 € |
| Abonnement | 19 €/mois | 1 900 € récurrents | 9 500 € récurrents |

---

## ❓ Problèmes fréquents

**Le webhook échoue ?**
→ Vérifiez que `STRIPE_WEBHOOK_SECRET` correspond à celui de votre endpoint Stripe.

**CORS bloqué ?**
→ Vérifiez que `FRONTEND_URL` dans `.env` correspond à l'URL exacte de votre frontend.

**Paiement refusé en production ?**
→ Passez de `sk_test_` à `sk_live_` dans `.env` et `pk_test_` à `pk_live_` dans `frontend.html`.
