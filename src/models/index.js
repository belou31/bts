// ⚠️ FICHIER UNIQUE D’AGRÉGATION — imports nommés pour tous les modèles
export { Campaign }      from './Campaign.js';
export { SeatHold }      from './SeatHold.js';
export { Tariff }        from './Tariff.js';
export { Zone }          from './Zone.js';
export { Counter }       from './Counter.js';
export { Order }         from './Order.js';
export { Season }        from './Season.js';
export { Seat }          from './Seat.js';
export { TariffPrice }   from './TariffPrice.js';
export { Event }         from './Event.js';
export { SeatCatalog }   from './SeatCatalog.js';
export { TariffPriceCatalog } from './TariffPriceCatalog.js';
export { Subscriber }    from './Subscriber.js';
export { Venue }         from './Venue.js';
export { ZoneHold }      from './ZoneHold.js';
export { AutomationJob } from './AutomationJob.js';
export { AdCampaign }    from './AdCampaign.js';
export { AdCampaignCatalog } from './AdCampaignCatalog.js';
export { AdCampaignPlacement } from './AdCampaignPlacement.js';
export { AdClick }       from './AdClick.js';
// Annuaire partenaire (services/partner-directory.js) : sans ces exports,
// scripts/sync-indexes.mjs ignorait ces modèles, et INT/PROD (autoIndex
// coupé hors développement) restaient sans unicité ni expiration des codes.
export { PartnerMember } from './PartnerMember.js';
export { PartnerLoginCode } from './PartnerLoginCode.js';
// Catalogue de zones d'un lieu : même raison (index unique venueSlug + key).
export { ZoneCatalog } from './ZoneCatalog.js';
