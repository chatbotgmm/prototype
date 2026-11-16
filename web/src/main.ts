// 시작점: 장면 등록 → 첫 화면. 주소 #장면 으로 바로 열 수도 있음(검토용).
import {register,start,go} from './core/scenes.js';
import {title} from './scenes/title.js';
import {village} from './scenes/village.js';
import {party} from './scenes/party.js';
import {pvp} from './scenes/pvp.js';
import {battle} from './scenes/battle.js';
import {result} from './scenes/result.js';
import {starter} from './scenes/starter.js';
import {recruit} from './scenes/recruit.js';
import {craft} from './scenes/craft.js';
import {collection} from './scenes/collection.js';
import {owned} from './scenes/owned.js';
import {adventure} from './scenes/adventure.js';
import {rebirth} from './scenes/rebirth.js';

register('title',title);register('village',village);register('party',party);
register('pvp',pvp);register('battle',battle);register('result',result);
register('starter',starter);register('recruit',recruit);register('craft',craft);register('collection',collection);register('owned',owned);register('adventure',adventure);register('rebirth',rebirth);
start(document.getElementById('game')!);
const first=location.hash.slice(1);
void go(['village','party','pvp','recruit','craft','collection','owned','rebirth'].includes(first)?first:'title');
