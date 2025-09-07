router.get('/bts/ha/return', (req, res) => {
  // Ne PAS se fier au query "code=succeeded" seul — le webhook valide vraiment.
  res.send('<h1>Merci ! Vérification en cours…</h1>');
});

router.get('/bts/ha/error', (req, res) => {
  res.status(400).send('<h1>Oups, une erreur est survenue.</h1>');
});

router.get('/bts/ha/back', (req, res) => {
  res.redirect('/abonnement'); // ex: retour panier
});
