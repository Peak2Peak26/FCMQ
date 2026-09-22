// Fonction serveur : crée un lien de paiement Square à partir du panier
// envoyé par index.html, puis retourne l'URL de paiement Square à laquelle
// le navigateur du client est redirigé.
//
// IMPORTANT : le jeton d'accès Square ne doit JAMAIS être écrit dans ce fichier.
// Il doit être ajouté comme variable d'environnement sur Netlify :
//   Site settings → Environment variables → SQUARE_ACCESS_TOKEN = EAAA...
//   Site settings → Environment variables → SQUARE_LOCATION_ID  = L...

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;
// Mettre 'https://connect.squareupsandbox.com' pendant les tests avec un jeton sandbox,
// puis repasser à 'https://connect.squareup.com' pour le vrai compte (production).
const SQUARE_API_BASE = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

// Catalogue = source de vérité des prix (jamais fait confiance aux prix envoyés
// par le navigateur, pour éviter qu'un client modifie le prix côté client).
const PRODUCTS = {
  tshirt:    { name: 'T-Shirt — FCMQ',    base: 2900 }, // en cents
  'manches-longues': { name: 'T-Shirt Manches Longues — FCMQ', base: 3500 },
  crewneck:  { name: 'Crewneck — FCMQ',   base: 4500 },
  hoodie:    { name: 'Hoodie — FCMQ',     base: 4900 },
  'veste-fz': { name: 'Veste Full Zip — FCMQ', base: 5500 },
  tuque:     { name: 'Tuque — FCMQ',      base: 2900 },
  casquette: { name: 'Casquette — FCMQ',  base: 2500 }
};
const BIG_SIZES = ['2XL', '3XL', '4XL'];
const SURCHARGE_CENTS = 500; // +5,00 $ pour 2XL / 3XL / 4XL
const VALID_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', 'Unique'];
const LIVRAISON_CENTS = 1000; // 10,00 $
const TPS_RATE = 0.05;
const TVQ_RATE = 0.09975;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }
  if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: "Configuration Square manquante (variables d'environnement)" }) };
  }

  let items, customer;
  try {
    const body = JSON.parse(event.body || '{}');
    items = body.items;
    customer = body.customer || {};
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };
  }

  if (!Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Le panier est vide' }) };
  }
  if (!customer.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email || '') ||
      !customer.adresse || !customer.ville || !customer.codepostal || !customer.province) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Coordonnées client incomplètes' }) };
  }

  try {
    const line_items = items.map(function (it) {
      const prod = PRODUCTS[it.id];
      if (!prod) throw new Error('Produit inconnu : ' + it.id);
      if (VALID_SIZES.indexOf(it.size) === -1) throw new Error('Grandeur invalide : ' + it.size);

      const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
      const unit_amount = prod.base + (BIG_SIZES.indexOf(it.size) !== -1 ? SURCHARGE_CENTS : 0);

      return {
        name: prod.name + ' — Grandeur ' + it.size,
        quantity: String(qty),
        base_price_money: { amount: unit_amount, currency: 'CAD' }
      };
    });

    // ── Livraison + taxes calculées sur le sous-total, ajoutées comme lignes distinctes ──
    const subtotalCents = line_items.reduce(function (s, li) {
      return s + li.base_price_money.amount * parseInt(li.quantity, 10);
    }, 0);
    const avantTaxesCents = subtotalCents + LIVRAISON_CENTS;
    const tpsCents = Math.round(avantTaxesCents * TPS_RATE);
    const tvqCents = Math.round(avantTaxesCents * TVQ_RATE);

    line_items.push({
      name: 'Livraison',
      quantity: '1',
      base_price_money: { amount: LIVRAISON_CENTS, currency: 'CAD' }
    });
    line_items.push({
      name: 'TPS (5%)',
      quantity: '1',
      base_price_money: { amount: tpsCents, currency: 'CAD' }
    });
    line_items.push({
      name: 'TVQ (9,975%)',
      quantity: '1',
      base_price_money: { amount: tvqCents, currency: 'CAD' }
    });

    const siteUrl = process.env.URL || 'https://fcmq.netlify.app';

    const payload = {
      idempotency_key: (Date.now().toString(36) + Math.random().toString(36).slice(2)),
      order: {
        location_id: SQUARE_LOCATION_ID,
        line_items: line_items
      },
      checkout_options: {
        redirect_url: siteUrl + '/merci.html',
        ask_for_shipping_address: false
      },
      pre_populated_data: {
        buyer_email: customer.email
      }
    };

    const resp = await fetch(SQUARE_API_BASE + '/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Square-Version': '2026-08-19',
        'Authorization': 'Bearer ' + SQUARE_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Erreur Square';
      return { statusCode: 500, body: JSON.stringify({ error: msg }) };
    }

    return { statusCode: 200, body: JSON.stringify({ url: data.payment_link.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
