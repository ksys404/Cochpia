import { randomUUID } from 'node:crypto';

// AI Agent:可自定义人格、模型的好友/群成员。
export function createAgentService(state, persist) {
  state.agents ||= [];
  const find = id => state.agents.find(agent => agent.id === id) || null;

  return {
    list() { return state.agents.slice(); },
    get(id) { return find(id); },
    create(input = {}) {
      const name = String(input.name || '').trim().slice(0, 40);
      if (!name) throw new Error('Agent name is required');
      const now = new Date().toISOString();
      const agent = {
        id: randomUUID(),
        name,
        persona: String(input.persona || '').trim().slice(0, 2000),
        provider: String(input.provider || '').trim().slice(0, 60),
        model: String(input.model || '').trim().slice(0, 120),
        avatar: String(input.avatar || '✦').slice(0, 8),
        relationship: String(input.relationship || '朋友').slice(0, 40),
        createdAt: now,
        updatedAt: now
      };
      state.agents.push(agent);
      return persist().then(() => agent);
    },
    update(id, input = {}) {
      const agent = find(id);
      if (!agent) return null;
      if (input.name !== undefined) {
        const name = String(input.name).trim().slice(0, 40);
        if (!name) throw new Error('Agent name is required');
        agent.name = name;
      }
      if (input.persona !== undefined) agent.persona = String(input.persona).trim().slice(0, 2000);
      if (input.provider !== undefined) agent.provider = String(input.provider).trim().slice(0, 60);
      if (input.model !== undefined) agent.model = String(input.model).trim().slice(0, 120);
      if (input.avatar !== undefined) agent.avatar = String(input.avatar).slice(0, 8);
      if (input.relationship !== undefined) agent.relationship = String(input.relationship).trim().slice(0, 40);
      agent.updatedAt = new Date().toISOString();
      return persist().then(() => agent);
    },
    remove(id) {
      const index = state.agents.findIndex(agent => agent.id === id);
      if (index === -1) return false;
      state.agents.splice(index, 1);
      return persist().then(() => true);
    }
  };
}
