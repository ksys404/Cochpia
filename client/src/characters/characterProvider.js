import { pipoyaTestAdapter } from '../pipoya/pipoyaTestAdapter';

/**
 * 可替换的角色素材提供器入口。
 *
 * CharacterProfile 和通用组合器只依赖 provider 接口，不依赖具体素材包。
 * 当前默认值仅用于开发预览；正式美术确定后，在这里替换为正式 provider，
 * 不需要改动角色数据结构或 CharacterComposer。
 */
export const activeCharacterProvider = pipoyaTestAdapter;

export function validateCharacterProvider(provider) {
  const required = ['getBodyTypes', 'getCategories', 'composeSprite', 'exportAvatar'];
  return Boolean(provider) && required.every(key => typeof provider[key] === 'function');
}
