import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { appUpdate } from './lib/update.svelte.ts';

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  appUpdate.watch();
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sans service worker l'application reste utilisable en ligne.
    });
  });
}

export default mount(App, { target: document.getElementById('app')! });
