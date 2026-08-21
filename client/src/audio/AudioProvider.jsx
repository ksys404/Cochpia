import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useWorkspacePreferences } from '../workspace/WorkspacePreferencesProvider';

const AudioContext = createContext(null);

export function AudioProvider({ children }) {
  const { state } = useWorkspacePreferences();
  const contextRef = useRef(null);
  const masterGainRef = useRef(null);
  const musicGainRef = useRef(null);
  const musicNodesRef = useRef([]);
  const [musicActive, setMusicActive] = useState(false);

  const ensureAudio = useCallback(async () => {
    if (!contextRef.current) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio API is unavailable in this browser');
      const context = new AudioContextClass();
      const master = context.createGain();
      const music = context.createGain();
      music.connect(master);
      master.connect(context.destination);
      contextRef.current = context;
      masterGainRef.current = master;
      musicGainRef.current = music;
    }
    if (contextRef.current.state === 'suspended') await contextRef.current.resume();
    return contextRef.current;
  }, []);

  useEffect(() => {
    const master = masterGainRef.current;
    const music = musicGainRef.current;
    if (!master || !music) return;
    const now = contextRef.current.currentTime;
    master.gain.setTargetAtTime(state.sound.muted ? 0 : 1, now, .04);
    music.gain.setTargetAtTime(state.sound.musicVolume * .22, now, .2);
  }, [state.sound.muted, state.sound.musicVolume]);

  useEffect(() => () => {
    musicNodesRef.current.forEach(node => { try { node.stop(); } catch { /* Already stopped. */ } });
    contextRef.current?.close();
  }, []);

  const playUiSound = useCallback(async (type = 'click') => {
    if (!state.sound.uiSoundEnabled || state.sound.muted || state.sound.uiVolume <= 0) return;
    const context = await ensureAudio();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    const frequency = type === 'success' ? 660 : type === 'error' ? 180 : 420;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.08, now + .08);
    gain.gain.setValueAtTime(state.sound.uiVolume * .16, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + .1);
    oscillator.connect(gain).connect(masterGainRef.current);
    oscillator.start(now);
    oscillator.stop(now + .11);
  }, [ensureAudio, state.sound.muted, state.sound.uiSoundEnabled, state.sound.uiVolume]);

  const startAmbientMusic = useCallback(async () => {
    if (musicActive || state.sound.muted || state.sound.musicVolume <= 0) return;
    const context = await ensureAudio();
    const frequencies = [130.81, 164.81, 196];
    const nodes = frequencies.map((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      oscillator.detune.value = index * 2 - 2;
      oscillator.connect(musicGainRef.current);
      oscillator.start();
      return oscillator;
    });
    musicNodesRef.current = nodes;
    setMusicActive(true);
  }, [ensureAudio, musicActive, state.sound.muted, state.sound.musicVolume]);

  const stopAmbientMusic = useCallback(() => {
    musicNodesRef.current.forEach(node => { try { node.stop(); } catch { /* Already stopped. */ } });
    musicNodesRef.current = [];
    setMusicActive(false);
  }, []);

  const toggleAmbientMusic = useCallback(() => musicActive ? stopAmbientMusic() : startAmbientMusic(), [musicActive, startAmbientMusic, stopAmbientMusic]);
  const value = { musicActive, playUiSound, startAmbientMusic, stopAmbientMusic, toggleAmbientMusic };
  return <AudioContext.Provider value={value}>{children}</AudioContext.Provider>;
}

export const useAudio = () => {
  const value = useContext(AudioContext);
  if (!value) throw new Error('useAudio must be used inside AudioProvider');
  return value;
};
