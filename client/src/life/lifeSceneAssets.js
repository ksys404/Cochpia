/**
 * Scene asset contract for the life-game vertical slice.
 *
 * Keep paths relative to the client app so real art can be dropped in later
 * without changing the scene component. Null means the CSS treatment remains
 * the source of truth; no network request is made for an empty slot.
 */
export const LIFE_SCENE_ASSETS = Object.freeze({
  bridge: Object.freeze({ background: '/life/kenney-rpg-urban-sample.png', midground: null, foreground: null, lighting: null }),
  cafe: Object.freeze({ background: null, midground: null, foreground: null, lighting: null }),
  home: Object.freeze({ background: null, midground: null, foreground: null, lighting: null })
});

export const LIFE_LOCATION_IDS = Object.freeze({
  '中央天桥': 'bridge',
  '微光咖啡馆': 'cafe',
  '公寓': 'home'
});

export function getLifeSceneAssets(location) {
  return LIFE_SCENE_ASSETS[LIFE_LOCATION_IDS[location] || location] || LIFE_SCENE_ASSETS.bridge;
}

export function getLifeLocationId(location) {
  return LIFE_LOCATION_IDS[location] || (LIFE_SCENE_ASSETS[location] ? location : 'bridge');
}
