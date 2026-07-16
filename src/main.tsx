import { render } from 'solid-js/web';
import App from './App';
import './app.css';

const root = document.getElementById('app');
if (!root) throw new Error('PostOwl root element is missing');

render(() => <App />, root);
