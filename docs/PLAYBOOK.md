# Billetterie BTS — Playbook d’installation (VPS INT & PROD)

Ce guide décrit **une installation propre** de BTS (Belougas Ticketing System) sur **Ubuntu 22.04 (Jammy)**, avec :
- Node.js + PM2
- MongoDB Community (authentifié)
- Nginx (reverse proxy HTTPS, chemin `/bts/`)
- Certbot (Let’s Encrypt)
- Déploiement applicatif (branche git)

> Topologie conseillée :  
> - **VPS-TEST** (INT) : `billetterie-test.belougas.fr`  
> - **VPS-PROD** (PROD) : `billetterie.belougas.fr`

---

## 0) Pré-requis

- DNS : le FQDN pointe vers l’IP du VPS (A/AAAA)
- OS : Ubuntu 22.04 LTS (Jammy)
- Un utilisateur applicatif : `bts` (home : `/home/bts`)

```bash
# connexion
ssh bts@<ip_vps>
