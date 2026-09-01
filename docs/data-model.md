---
title: Data Model
nav_order: 120
---

# Data Model

> Generated from code.
> Source: src/models/*.js
> Regenerate with: `npm run docs:refs`

## Model inventory

| Model | Family | Top-level fields | Indexes |
| --- | --- | --- | --- |
| `AdCampaign` | Autres | 8 | 1 |
| `AdCampaignCatalog` | Autres | 16 | 2 |
| `AdCampaignPlacement` | Autres | 17 | 7 |
| `AdClick` | Autres | 8 | 3 |
| `AutomationJob` | Audience / opérations | 14 | 3 |
| `Campaign` | Audience / opérations | 8 | 1 |
| `Counter` | Audience / opérations | 4 | 1 |
| `Event` | Événements et contrôle | 14 | 6 |
| `Order` | Runtime saison / vente | 21 | 18 |
| `Season` | Runtime saison / vente | 10 | 4 |
| `Seat` | Runtime saison / vente | 8 | 11 |
| `SeatCatalog` | Catalogue | 9 | 2 |
| `SeatHold` | Événements et contrôle | 12 | 9 |
| `Subscriber` | Audience / opérations | 17 | 6 |
| `Tariff` | Autres | 11 | 4 |
| `TariffPrice` | Autres | 12 | 7 |
| `TariffPriceCatalog` | Catalogue | 11 | 3 |
| `Venue` | Catalogue | 6 | 1 |
| `Zone` | Runtime saison / vente | 14 | 6 |
| `ZoneHold` | Runtime saison / vente | 8 | 4 |

## Autres

### AdCampaign

#### Top-level fields

- `active`: `Boolean`
- `assetKind`: `String`
- `assetPaths`: `Array<String>`
- `createdAt`: `Date`
- `label`: `String`
- `slug`: `String`
- `targetUrl`: `String`
- `updatedAt`: `Date`

#### Indexes

`slug:1` (unique)

### AdCampaignCatalog

#### Top-level fields

- `active`: `Boolean`
- `campaignSlug`: `String`
- `catalogSlug`: `String`
- `contentType`: `String`
- `createdAt`: `Date`
- `endsAt`: `Date`
- `priority`: `Number`
- `qrValue`: `String`
- `slot`: `String`
- `startsAt`: `Date`
- `tariffCode`: `String`
- `text`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `zoneKey`: `String`
- `zoneType`: `String`

#### Indexes

`venueSlug:1`<br>`catalogSlug:1, venueSlug:1, campaignSlug:1, slot:1, tariffCode:1, zoneKey:1, zoneType:1` (name=uniq_ad_campaign_catalog_entry, unique)

### AdCampaignPlacement

#### Top-level fields

- `active`: `Boolean`
- `campaignSlug`: `String`
- `contentType`: `String`
- `createdAt`: `Date`
- `endsAt`: `Date`
- `priceTableKey`: `String`
- `priority`: `Number`
- `qrValue`: `String`
- `seasonCode`: `String`
- `slot`: `String`
- `startsAt`: `Date`
- `tariffCode`: `String`
- `text`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `zoneKey`: `String`
- `zoneType`: `String`

#### Indexes

`seasonCode:1`<br>`venueSlug:1`<br>`priceTableKey:1`<br>`priceTableKey:1, campaignSlug:1, slot:1, tariffCode:1, zoneKey:1, zoneType:1` (name=uniq_ad_campaign_placement_per_priceTableKey, unique)<br>`seasonCode:1, venueSlug:1, campaignSlug:1, slot:1, tariffCode:1, zoneKey:1, zoneType:1` (name=uniq_ad_campaign_placement_per_season, unique)<br>`priceTableKey:1, slot:1, active:1`<br>`seasonCode:1, venueSlug:1, slot:1, active:1`

### AdClick

#### Top-level fields

- `campaignSlug`: `String`
- `clickedAt`: `Date`
- `ip`: `String`
- `orderId`: `ObjectId`
- `targetUrl`: `String`
- `ticketId`: `ObjectId`
- `token`: `String`
- `userAgent`: `String`

#### Indexes

`campaignSlug:1`<br>`ticketId:1`<br>`orderId:1`

### Tariff

#### Top-level fields

- `active`: `Boolean`
- `channels`: `Array<String>`
- `code`: `String`
- `createdAt`: `Date`
- `fieldLabel`: `String`
- `label`: `String`
- `priceTableKey`: `String`
- `requiresField`: `String`
- `requiresInfo`: `String`
- `sortOrder`: `Number`
- `updatedAt`: `Date`

#### Indexes

`priceTableKey:1`<br>`active:1, sortOrder:1`<br>`code:1` (name=uniq_code_global_when_priceTableKey_null, unique)<br>`priceTableKey:1, code:1` (name=uniq_code_per_priceTableKey, unique)

### TariffPrice

#### Top-level fields

- `channels`: `Array<String>`
- `createdAt`: `Date`
- `currency`: `String`
- `metaZone`: `String`
- `partnerPriceCents`: `Number`
- `priceCents`: `Number`
- `priceTableKey`: `String`
- `seasonCode`: `String`
- `tariffCode`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `zoneKey`: `String`

#### Indexes

`seasonCode:1`<br>`venueSlug:1`<br>`zoneKey:1`<br>`metaZone:1`<br>`priceTableKey:1`<br>`seasonCode:1, venueSlug:1, zoneKey:1, metaZone:1, tariffCode:1` (name=uniq_season_venue_zone_tariff, unique)<br>`priceTableKey:1, zoneKey:1, metaZone:1, tariffCode:1` (name=uniq_priceTable_zone_tariff, unique)

## Audience / opérations

### AutomationJob

#### Top-level fields

- `createdAt`: `Date`
- `dryRun`: `Boolean`
- `error`: `Embedded`
- `finishedAt`: `Date`
- `logs`: `Array`
- `params`: `Mixed`
- `requestContext`: `Embedded`
- `requestedBy`: `String`
- `result`: `Embedded`
- `scriptId`: `String`
- `startedAt`: `Date`
- `status`: `String`
- `updatedAt`: `Date`
- `version`: `String`

#### Indexes

`scriptId:1`<br>`status:1`<br>`createdAt:-1`

### Campaign

#### Top-level fields

- `code`: `String`
- `createdAt`: `Date`
- `maxUses`: `Number`
- `meta`: `Mixed`
- `phase`: `String`
- `seasonCode`: `String`
- `updatedAt`: `Date`
- `used`: `Number`

#### Indexes

`code:1` (unique)

### Counter

#### Top-level fields

- `createdAt`: `Date`
- `key`: `String`
- `seq`: `Number`
- `updatedAt`: `Date`

#### Indexes

`key:1` (unique)

### Subscriber

#### Top-level fields

- `createdAt`: `Date`
- `email`: `String`
- `extra`: `Number`
- `firstName`: `String`
- `group`: `String`
- `groupKey`: `String`
- `lastInviteSentAt`: `Date`
- `lastName`: `String`
- `notes`: `String`
- `phone`: `String`
- `prefSeatId`: `String`
- `previousSeasonSeats`: `Array<String>`
- `seasonCode`: `String`
- `status`: `String`
- `subscriberNo`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`

#### Indexes

`email:1`<br>`groupKey:1`<br>`prefSeatId:1`<br>`seasonCode:1`<br>`venueSlug:1`<br>`subscriberNo:1` (unique)

## Événements et contrôle

### Event

#### Top-level fields

- `activity`: `String`
- `createdAt`: `Date`
- `description`: `String`
- `name`: `String`
- `priceTableKey`: `String`
- `sale`: `String`
- `seasonCode`: `String`
- `slug`: `String`
- `startsAt`: `Date`
- `tags`: `Array<String>`
- `templateTheme`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `venueView`: `String`

#### Indexes

`slug:1` (unique)<br>`seasonCode:1`<br>`venueSlug:1`<br>`sale:1`<br>`activity:1`<br>`tags:1`

### SeatHold

#### Top-level fields

- `createdAt`: `Date`
- `eventId`: `ObjectId`
- `expiresAt`: `Date`
- `forced`: `Boolean`
- `orderId`: `ObjectId`
- `reason`: `String`
- `seasonCode`: `String`
- `seatId`: `String`
- `sessionToken`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `zoneKey`: `String`

#### Indexes

`eventId:1`<br>`seasonCode:1`<br>`venueSlug:1`<br>`seatId:1`<br>`zoneKey:1`<br>`sessionToken:1`<br>`eventId:1, seatId:1` (name=idx_event_seat, unique)<br>`eventId:1, zoneKey:1` (name=idx_event_zone)<br>`expiresAt:1` (name=ttl_expiresAt, ttl=0)

## Runtime saison / vente

### Order

#### Top-level fields

- `createdAt`: `Date`
- `eventId`: `ObjectId`
- `groupKey`: `String`
- `itemName`: `String`
- `lines`: `Array`
- `locale`: `String`
- `mailTemplateKind`: `String`
- `meta`: `Mixed`
- `parentOrderId`: `ObjectId`
- `payerEmail`: `String`
- `payerFirstName`: `String`
- `payerLastName`: `String`
- `paymentProvider`: `String`
- `paymentProviderMeta`: `Mixed`
- `paymentSplit`: `Number`
- `providerRef`: `String`
- `seasonCode`: `String`
- `status`: `String`
- `totalCents`: `Number`
- `updatedAt`: `Date`
- `venueSlug`: `String`

#### Indexes

`seasonCode:1`<br>`venueSlug:1`<br>`eventId:1`<br>`parentOrderId:1`<br>`groupKey:1`<br>`itemName:1`<br>`payerEmail:1`<br>`lines.tariffCode:1`<br>`status:1`<br>`origin.flow:1`<br>`mailTemplateKind:1`<br>`seasonCode:1, venueSlug:1, groupKey:1, status:1` (name=idx_group_status)<br>`seasonCode:1, venueSlug:1, groupKey:1, payerEmail:1, status:1` (name=uniq_paid_per_payer, unique)<br>`eventId:1, parentOrderId:1, status:1` (name=idx_event_parent_status)<br>`paymentProviderMeta.checkoutIntentId:1` (name=idx_provider_intent, sparse)<br>`paymentProviderMeta.tokenHash:1` (name=idx_provider_tokenhash, sparse)<br>`meta.checkoutIntentId:1` (name=idx_legacy_intent, sparse)<br>`meta.tokenHash:1` (name=idx_legacy_tokenhash, sparse)

### Season

#### Top-level fields

- `active`: `Boolean`
- `activity`: `String`
- `code`: `String`
- `createdAt`: `Date`
- `name`: `String`
- `renew`: `String`
- `subscribe`: `String`
- `templateTheme`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`

#### Indexes

`code:1` (unique)<br>`activity:1`<br>`renew:1`<br>`subscribe:1`

### Seat

#### Top-level fields

- `createdAt`: `Date`
- `provisionedFor`: `ObjectId`
- `seasonCode`: `String`
- `seatId`: `String`
- `status`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `zoneKey`: `String`

#### Indexes

`zoneKey:1`<br>`seasonCode:1`<br>`venueSlug:1`<br>`status:1`<br>`meta.hold.until:1`<br>`provisionedFor:1`<br>`seasonCode:1, venueSlug:1, seatId:1` (name=uniq_seat_per_season_venue, unique)<br>`seasonCode:1, zoneKey:1`<br>`seasonCode:1, status:1`<br>`meta.hold.until:1` (name=idx_hold_until, sparse)<br>`meta.hold.orderId:1` (name=idx_hold_order, sparse)

### Zone

#### Top-level fields

- `access`: `String`
- `basePriceCents`: `Number`
- `capacity`: `Number`
- `createdAt`: `Date`
- `isActive`: `Boolean`
- `key`: `String`
- `metaZone`: `String`
- `name`: `String`
- `quota`: `Number`
- `seasonCode`: `String`
- `svgSelector`: `String`
- `type`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`

#### Indexes

`key:1`<br>`metaZone:1`<br>`seasonCode:1`<br>`venueSlug:1`<br>`access:1`<br>`seasonCode:1, venueSlug:1, key:1` (name=uniq_zone_season_venue_key, unique)

### ZoneHold

#### Top-level fields

- `createdAt`: `Date`
- `expiresAt`: `Date`
- `orderId`: `ObjectId`
- `qty`: `Number`
- `seasonCode`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `zoneKey`: `String`

#### Indexes

`seasonCode:1`<br>`venueSlug:1`<br>`zoneKey:1`<br>`expiresAt:1` (name=ttl_zonehold_expiresAt, ttl=0)

## Catalogue

### SeatCatalog

#### Top-level fields

- `createdAt`: `Date`
- `meta`: `Mixed`
- `number`: `String`
- `row`: `String`
- `seatId`: `String`
- `svgSelector`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `zoneKey`: `String`

#### Indexes

`venueSlug:1`<br>`venueSlug:1, seatId:1` (unique)

### TariffPriceCatalog

#### Top-level fields

- `catalogSlug`: `String`
- `channels`: `Array<String>`
- `createdAt`: `Date`
- `currency`: `String`
- `metaZone`: `String`
- `partnerPriceCents`: `Number`
- `priceCents`: `Number`
- `tariffCode`: `String`
- `updatedAt`: `Date`
- `venueSlug`: `String`
- `zoneKey`: `String`

#### Indexes

`venueSlug:1`<br>`metaZone:1`<br>`catalogSlug:1, venueSlug:1, zoneKey:1, metaZone:1, tariffCode:1` (name=uniq_tariff_price_catalog_entry, unique)

### Venue

#### Top-level fields

- `createdAt`: `Date`
- `name`: `String`
- `slug`: `String`
- `svgPath`: `String`
- `updatedAt`: `Date`
- `zones`: `Array`

#### Indexes

`slug:1` (unique)

