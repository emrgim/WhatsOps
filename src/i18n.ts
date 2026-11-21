/**
 * Bilingual (English / Italian) strings for everything the server says:
 * MCP tool titles & descriptions, error messages, login/consent pages, the WhatsApp login code.
 *
 * Keys are the English source strings (gettext style); keys starting with "@" are long texts.
 * Language resolution:
 *   - server default: settings.language ('auto' | 'en' | 'it'); 'auto' = WA_LANG env, else the OS locale
 *   - per request: ?lang= (API clients) > Accept-Language > server default — no manual switch in the UI
 */
import type { FastifyRequest } from 'fastify'
import { AppError, fmt } from './util.js'

export type Lang = 'en' | 'it'
export const LANGS: Lang[] = ['en', 'it']

export function normLang(v?: string | null): Lang | null {
  if (!v) return null
  const l = String(v).toLowerCase().trim()
  if (l.startsWith('it')) return 'it'
  if (l.startsWith('en')) return 'en'
  return null
}

/** Language of the operating system the server runs on. */
export function osLang(): Lang {
  const env = process.env
  for (const v of [env.WA_LANG, env.LC_ALL, env.LC_MESSAGES, (env.LANGUAGE ?? '').split(':')[0], env.LANG]) {
    if (!v || v === 'C' || v.startsWith('C.') || v === 'POSIX') continue
    const l = normLang(v)
    if (l) return l
  }
  try {
    return normLang(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en'
  } catch {
    return 'en'
  }
}

let serverDefault: Lang = osLang()

export function setServerLanguage(setting: string | undefined): Lang {
  serverDefault = normLang(setting) ?? osLang()
  return serverDefault
}

export function defaultLang(): Lang {
  return serverDefault
}

export function fromAcceptLanguage(h?: string | string[] | null): Lang | null {
  if (!h) return null
  const items = String(Array.isArray(h) ? h.join(',') : h)
    .split(',')
    .map((p) => {
      const [tag, ...rest] = p.trim().split(';')
      const q = rest.find((r) => r.trim().startsWith('q='))
      return { tag, q: q ? Number(q.trim().slice(2)) || 0 : 1 }
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q)
  for (const it of items) {
    const l = normLang(it.tag)
    if (l) return l
  }
  return null
}

export function reqLang(req: FastifyRequest): Lang {
  const q = (req.query ?? {}) as Record<string, unknown>
  return (
    normLang(typeof q.lang === 'string' ? q.lang : null) ??
    fromAcceptLanguage(req.headers['accept-language']) ??
    serverDefault
  )
}

export function tr(lang: Lang, s: string, params: unknown[] = []): string {
  const dict = lang === 'it' ? IT : EN
  const t = dict[s] ?? EN[s] ?? s
  return fmt(t, params)
}

export function localizeError(e: AppError, lang: Lang): string {
  return tr(lang, e.template, e.params)
}

// ---------------------------------------------------------------------------
// English long texts
// ---------------------------------------------------------------------------
const EN: Record<string, string> = {
  '@instructions': `WhatsApp (Baileys linked device) for the owner's own WhatsApp numbers.
- Recipients/chats accept a phone number in international format (+971501234567), a JID (…@s.whatsapp.net, …@g.us, …@lid) or an exact chat/contact name.
- Resolve people with whatsapp_find_contact before sending when you only have a name.
- Messages are sent as the owner: confirm wording and recipient with the user before calling a send tool unless they explicitly asked you to send.
- Use whatsapp_accounts to see which numbers are connected; pass "account" to pick a non-default number.
- Reply to the user in their language.`,
  '@otp': '🔐 WhatsOps login code: *{0}*\nValid for 5 minutes. If you did not request it, ignore this message.',
  '@otp_user': '🔐 WhatsOps — {1}, your login code: *{0}*\nValid for 5 minutes. If you did not request it, ignore this message.',
  '@crms_code': '🔐 WhatsOps · Current RMS ({1}): your code is *{0}*\nValid for 10 minutes. If you did not request it, ignore this message.',
  '@login_hint':
    'First access, or no number linked yet? Ask your agent for a <i>login link</i> (valid 30 minutes) or run <code>mcp-mrg-whatsops login-link</code> on the server.',
}

// ---------------------------------------------------------------------------
// Italian
// ---------------------------------------------------------------------------
const IT: Record<string, string> = {
  '@instructions': `WhatsApp (dispositivo collegato via Baileys) sui numeri WhatsApp del proprietario.
- Destinatari e chat accettano un numero in formato internazionale (+971501234567), un JID (…@s.whatsapp.net, …@g.us, …@lid) o il nome esatto di una chat/contatto.
- Se hai solo un nome, risolvi la persona con whatsapp_find_contact prima di inviare.
- I messaggi partono a nome del proprietario: conferma testo e destinatario con l'utente prima di usare uno strumento di invio, salvo che te l'abbia chiesto esplicitamente.
- whatsapp_accounts mostra i numeri collegati; passa "account" per usare un numero diverso da quello predefinito.
- Rispondi all'utente nella sua lingua.`,
  '@otp': '🔐 Codice di accesso WhatsOps: *{0}*\nValido 5 minuti. Se non l’hai chiesto tu, ignora questo messaggio.',
  '@otp_user': '🔐 WhatsOps — {1}, il tuo codice di accesso: *{0}*\nValido 5 minuti. Se non l’hai chiesto tu, ignora questo messaggio.',
  '@crms_code': '🔐 WhatsOps · Current RMS ({1}): il tuo codice è *{0}*\nValido 10 minuti. Se non l’hai chiesto tu, ignora questo messaggio.',
  '@login_hint':
    'Primo accesso o nessun numero collegato? Chiedi al tuo agente un <i>link di accesso</i> (valido 30 minuti) oppure esegui <code>mcp-mrg-whatsops login-link</code> sul server.',

  // ---- server / MCP
  'Read and send WhatsApp messages from your own numbers (multi-account, Baileys).': 'Leggi e invia messaggi WhatsApp dai tuoi numeri (più account, Baileys).',
  'Unauthorized: sign in with OAuth or send Authorization: Bearer <API key>': 'Non autorizzato: accedi con OAuth oppure invia Authorization: Bearer <chiave API>',
  'Method not allowed (stateless server: use POST)': 'Metodo non consentito (server stateless: usa POST)',
  'WhatsApp account id or phone number to use. Omit for the default account (see whatsapp_accounts).':
    'Id account o numero WhatsApp da usare. Ometti per il numero predefinito (vedi whatsapp_accounts).',
  'List WhatsApp numbers': 'Elenca numeri WhatsApp',
  'List the WhatsApp numbers (accounts) configured on this server with their connection state.': 'Elenca i numeri WhatsApp (account) configurati su questo server con lo stato di connessione.',
  'List chats': 'Elenca chat',
  'List recent chats (most recent first) with the last message preview and unread count.': 'Elenca le chat recenti (dalla più recente) con anteprima dell’ultimo messaggio e numero di non letti.',
  'Max chats (default 30)': 'Numero massimo di chat (predefinito 30)',
  'Skip this many chats (paging)': 'Salta questo numero di chat (paginazione)',
  'Only chats with unread messages': 'Solo chat con messaggi non letti',
  'Filter by chat name': 'Filtra per nome della chat',
  'Chat type: all, groups or direct': 'Tipo di chat: all (tutte), groups (gruppi) o direct (individuali)',
  'Read chat messages': 'Leggi messaggi della chat',
  'Get messages of one chat in chronological order (oldest → newest). Use before/after (ISO date) to page.':
    'Messaggi di una chat in ordine cronologico (dal più vecchio al più recente). Usa before/after (data ISO) per scorrere.',
  'Phone number (+971…), JID or exact chat/contact name': 'Numero (+971…), JID o nome esatto della chat/contatto',
  'Max messages (default 30)': 'Numero massimo di messaggi (predefinito 30)',
  'Only messages before this ISO timestamp': 'Solo messaggi precedenti a questa data ISO',
  'Only messages after this ISO timestamp': 'Solo messaggi successivi a questa data ISO',
  'Search messages': 'Cerca messaggi',
  'Full-text search across stored WhatsApp messages (newest first).': 'Ricerca testuale nei messaggi WhatsApp salvati (dai più recenti).',
  'Text to search for': 'Testo da cercare',
  'Restrict to one chat (number, JID or name)': 'Limita a una chat (numero, JID o nome)',
  'ISO date lower bound': 'Data ISO minima',
  'Max results (default 30)': 'Numero massimo di risultati (predefinito 30)',
  'Find contact': 'Trova contatto',
  'Find contacts, chats and groups by name or (partial) phone number. Returns JIDs and phone numbers to use with other tools.':
    'Trova contatti, chat e gruppi per nome o numero (anche parziale). Restituisce JID e numeri da usare con gli altri strumenti.',
  'Name or phone number': 'Nome o numero di telefono',
  'Max results (default 20)': 'Numero massimo di risultati (predefinito 20)',
  'Check number on WhatsApp': 'Verifica numero su WhatsApp',
  'Check whether a phone number has WhatsApp.': 'Verifica se un numero di telefono ha WhatsApp.',
  'Phone number in international format': 'Numero in formato internazionale',
  'List groups': 'Elenca gruppi',
  'List the WhatsApp groups this number participates in.': 'Elenca i gruppi WhatsApp di cui fa parte questo numero.',
  'Filter by group name': 'Filtra per nome del gruppo',
  'Re-fetch from WhatsApp first': 'Aggiorna prima da WhatsApp',
  'Group details': 'Dettagli gruppo',
  'Group metadata with participants (names, phone numbers, admins).': 'Dati del gruppo con i partecipanti (nomi, numeri, amministratori).',
  'Group JID (…@g.us) or exact group name': 'JID del gruppo (…@g.us) o nome esatto del gruppo',
  'Send text message': 'Invia messaggio di testo',
  'Send a WhatsApp text message as the owner. Confirm recipient and text with the user first.': 'Invia un messaggio di testo WhatsApp a nome del proprietario. Conferma prima destinatario e testo con l’utente.',
  'Phone number (+971…), JID, group JID or exact chat name': 'Numero (+971…), JID, JID di gruppo o nome esatto della chat',
  'Message text': 'Testo del messaggio',
  'Message id to quote': 'Id del messaggio da citare',
  'Phone numbers/JIDs to @mention (groups)': 'Numeri/JID da @menzionare (gruppi)',
  'Same key = sent at most once': 'Stessa chiave = inviato al massimo una volta',
  'Send media': 'Invia media',
  'Send an image, video, audio/voice note, document or sticker from a public URL or base64.': 'Invia immagine, video, audio/vocale, documento o sticker da un URL pubblico o in base64.',
  'Recipient: phone number, JID or exact chat name': 'Destinatario: numero, JID o nome esatto della chat',
  'Media type': 'Tipo di media',
  'http(s) URL of the file': 'URL http(s) del file',
  'File content as base64 (or data: URL)': 'Contenuto del file in base64 (o data: URL)',
  'MIME type, e.g. image/jpeg': 'Tipo MIME, es. image/jpeg',
  'File name (documents)': 'Nome del file (documenti)',
  Caption: 'Didascalia',
  'Send audio as a voice note': 'Invia l’audio come messaggio vocale',
  'Send location': 'Invia posizione',
  'Send a location pin.': 'Invia una posizione sulla mappa.',
  Latitude: 'Latitudine',
  Longitude: 'Longitudine',
  'Place name': 'Nome del luogo',
  Address: 'Indirizzo',
  'React to message': 'Reagisci al messaggio',
  'React to a message with an emoji (empty emoji removes the reaction).': 'Reagisci a un messaggio con un’emoji (emoji vuota = rimuove la reazione).',
  'Chat: phone number, JID or exact chat name': 'Chat: numero, JID o nome esatto della chat',
  'Message id': 'Id del messaggio',
  'e.g. 👍 — empty string removes': 'es. 👍 — stringa vuota per rimuovere',
  'Mark as read': 'Segna come letto',
  'Mark a chat (or specific messages) as read — sends blue ticks.': 'Segna come letta una chat (o messaggi specifici): invia le spunte blu.',
  'Message ids (default: latest received)': 'Id dei messaggi (predefinito: gli ultimi ricevuti)',
  'Edit message': 'Modifica messaggio',
  'Edit the text of a message previously sent by this number.': 'Modifica il testo di un messaggio inviato in precedenza da questo numero.',
  'New text': 'Nuovo testo',
  'Delete message for everyone': 'Elimina messaggio per tutti',
  'Delete (revoke) a message for everyone.': 'Elimina (revoca) un messaggio per tutti.',
  'Download media': 'Scarica media',
  'Get the media of a message: returns a temporary download link (1 h) and, for small images, the image itself.':
    'Ottieni il media di un messaggio: restituisce un link temporaneo (1 ora) e, per le immagini piccole, l’immagine stessa.',

  // ---- pages
  'Sign in · WhatsOps': 'Accesso · WhatsOps',
  'Configuration of the WhatsApp server (numbers, database, API keys, MCP connectors).': 'Configurazione del server WhatsApp (numeri, database, chiavi API, connettori MCP).',
  'Get a login code in the <b>“Message yourself”</b> chat of the linked WhatsApp number.': 'Ricevi un codice di accesso nella chat <b>“Messaggi a te stesso”</b> del numero WhatsApp collegato.',
  'Send me the code on WhatsApp': 'Mandami il codice su WhatsApp',
  'Sign in': 'Entra',
  'Admin password': 'Password amministratore',
  'Sign in with password': 'Entra con password',
  'Code sent to {0} · resend': 'Codice inviato a {0} · reinvia',
  'Authorize · WhatsOps': 'Autorizza · WhatsOps',
  'Read chats, messages, contacts and groups': 'Leggere chat, messaggi, contatti e gruppi',
  'Send messages, media and reactions on your behalf': 'Inviare messaggi, media e reazioni a tuo nome',
  '<b>{0}</b> is asking for access to your WhatsApp.': '<b>{0}</b> chiede accesso al tuo WhatsApp.',
  'Sign in as the owner first.': 'Prima accedi come proprietario.',
  '<b>{0}</b> wants to connect to your WhatsApp server.': '<b>{0}</b> vuole collegarsi al tuo server WhatsApp.',
  'After authorizing you will be sent back to <b>{0}</b>. You can revoke access at any time from the config page → Connectors.':
    'Dopo l’autorizzazione verrai rimandato a <b>{0}</b>. Puoi revocare l’accesso in qualsiasi momento dalla pagina di configurazione → Connettori.',
  Deny: 'Rifiuta',
  Authorize: 'Autorizza',
  'Authorization · WhatsOps': 'Autorizzazione · WhatsOps',
  'Incomplete authorization URL.': 'URL di autorizzazione incompleta.',
  'client_id, redirect_uri or code_challenge (PKCE) is missing. Start the connection from your MCP client (Cursor, Claude, Grok…) using the server address:':
    'Mancano client_id, redirect_uri o code_challenge (PKCE). Avvia la connessione dal client MCP (Cursor, Claude, Grok…) usando l’indirizzo del server:',
  'For clients without OAuth, create an API key on the config page.': 'Per i client senza OAuth crea una chiave API nella pagina di configurazione.',
  'Open config page': 'Apri configurazione',
  Continue: 'Continua',
  'Invalid link': 'Link non valido',
  'Login link expired or already used. Ask for a new one.': 'Link di accesso scaduto o già usato. Chiedine uno nuovo.',
  'Sign in to the WhatsOps config first': 'Accedi prima alla configurazione di WhatsOps',
  'The owner denied access': 'Il proprietario ha negato l’accesso',
  'Unknown client_id "{0}". Register the client (dynamic registration) or use a known id such as "grok".':
    'client_id "{0}" sconosciuto. Registra il client (registrazione dinamica) o usa un id noto come "grok".',
  'redirect_uri missing or not registered for this client': 'redirect_uri mancante o non registrato per questo client',

  // ---- errors
  'Recipient is empty': 'Destinatario vuoto',
  'Unsupported JID server {0}': 'Server JID non supportato: {0}',
  '"{0}" is not a valid phone number (use international format, e.g. +971501234567)': '"{0}" non è un numero valido (usa il formato internazionale, es. +971501234567)',
  'This credential lacks the "{0}" scope': 'Questa credenziale non ha il permesso "{0}"',
  'This credential cannot use account "{0}"': 'Questa credenziale non può usare l’account "{0}"',
  'Missing or invalid credentials (Bearer API key, OAuth token or admin session)': 'Credenziali mancanti o non valide (chiave API Bearer, token OAuth o sessione amministratore)',
  'WhatsApp login codes are disabled': 'L’accesso con codice WhatsApp è disattivato',
  'Too many codes requested, wait a few minutes': 'Troppi codici richiesti, attendi qualche minuto',
  'No connected WhatsApp number to send the code to. Use a login link.': 'Nessun numero WhatsApp connesso a cui inviare il codice. Usa un link di accesso.',
  'Wrong or expired code': 'Codice errato o scaduto',
  'Wrong password': 'Password errata',
  'Connection failed: {0}': 'Connessione non riuscita: {0}',
  'WA_DB_URL is set in the service environment; remove it to manage the database from here': 'WA_DB_URL è impostata nell’ambiente del servizio: rimuovila per gestire il database da qui',
  'Switch aborted, still on the current database: {0}': 'Spostamento annullato, il database attuale resta in uso: {0}',
  'webhook not found': 'webhook non trovato',
  'A phone number in international format is required for pairing-code login': 'Per il collegamento con codice serve un numero in formato internazionale',
  'WhatsApp account "{0}" is not connected (state: {1})': 'L’account WhatsApp "{0}" non è connesso (stato: {1})',
  '+{0} is not on WhatsApp': '+{0} non è su WhatsApp',
  'WhatsApp did not return a message': 'WhatsApp non ha restituito il messaggio',
  '{0} not found': '{0} non trovato',
  'That session folder is not linked to a WhatsApp account': 'Quella cartella di sessione non è collegata a un account WhatsApp',
  'No WhatsApp number is configured yet. Add one in the config page.': 'Nessun numero WhatsApp configurato. Aggiungine uno nella pagina di configurazione.',
  'WhatsApp account "{0}" not found': 'Account WhatsApp "{0}" non trovato',
  'chat/recipient is required': 'chat/destinatario obbligatorio',
  'No chat or contact named "{0}". Use a phone number in international format.': 'Nessuna chat o contatto con nome "{0}". Usa un numero in formato internazionale.',
  '"{0}" matches several chats: {1}. Use the phone number or JID.': '"{0}" corrisponde a più chat: {1}. Usa il numero o il JID.',
  'Sending to {0} is blocked by the send allowlist (config page → Settings).': 'L’invio a {0} è bloccato dall’elenco dei destinatari consentiti (configurazione → Impostazioni).',
  'No previous conversation with {0}; cold messaging is disabled in settings.': 'Nessuna conversazione precedente con {0}: i messaggi a nuovi contatti sono disattivati nelle impostazioni.',
  'A send with this idempotency key is still in progress': 'Un invio con questa chiave di idempotenza è ancora in corso',
  '{0} is not a group': '{0} non è un gruppo',
  'Group {0} not found': 'Gruppo {0} non trovato',
  'Message {0} not found in {1}': 'Messaggio {0} non trovato in {1}',
  'text is required': 'il testo è obbligatorio',
  'media url is not a valid URL': 'l’URL del media non è valido',
  'Only http(s) media URLs are allowed': 'Sono ammessi solo URL http(s)',
  'Fetching media failed: HTTP {0}': 'Download del media non riuscito: HTTP {0}',
  'Media larger than {0} MB': 'Media più grande di {0} MB',
  'media too large': 'media troppo grande',
  'Provide url or base64': 'Fornisci url o base64',
  'media is empty': 'il media è vuoto',
  'Only messages sent by this account can be edited': 'Si possono modificare solo i messaggi inviati da questo account',
  'Only your own messages can be deleted for everyone': 'Puoi eliminare per tutti solo i tuoi messaggi',
  'Message {0} not found': 'Messaggio {0} non trovato',
  'This message has no media': 'Questo messaggio non contiene media',
  'media larger than the configured cap': 'media più grande del limite configurato',
  'Media download failed: {0}': 'Download del media non riuscito: {0}',
  'invalid media link': 'link al media non valido',
  'media link expired': 'link al media scaduto',
  'Too many failed attempts, try again in a few minutes': 'Troppi tentativi falliti, riprova fra qualche minuto',
  'Password must be at least 10 characters': 'La password deve avere almeno 10 caratteri',
  'At least one scope (read, send, admin) is required': 'Serve almeno un permesso (read, send, admin)',
  'Internal error': 'Errore interno',
  '{0} {1} not found': '{0} {1} non trovato',
  'Send feedback about WhatsOps': 'Invia un feedback su WhatsOps',
  'Send feedback about WhatsOps itself (a bug, an idea, anything else) to its developers. It opens a PUBLIC issue in the GitHub repository emrgim/WhatsOps, signed only with this installation code: never put phone numbers, names, message contents or keys in it. Show the text to the user and get their OK before sending.': 'Invia agli sviluppatori un feedback su WhatsOps (un problema, un\'idea, altro). Apre una issue PUBBLICA nella repository GitHub emrgim/WhatsOps, firmata solo con il codice di questa installazione: non metterci mai numeri di telefono, nomi, contenuti di messaggi o chiavi. Mostra il testo all\'utente e ottieni il suo ok prima di inviarlo.',
  'bug = something does not work, idea = a request or an improvement, other = anything else': 'bug = qualcosa non funziona, idea = una richiesta o un miglioramento, other = altro',
  'Short title (3–120 characters)': 'Titolo breve (3–120 caratteri)',
  'What happened or what you would like, in detail': 'Cosa è successo o cosa vorresti, nel dettaglio',
  'Attach technical info: WhatsOps version, operating system, database type, how many numbers are linked (no phone numbers, no messages). Default true.': 'Allega le info tecniche: versione di WhatsOps, sistema operativo, tipo di database, quanti numeri sono collegati (niente numeri di telefono né messaggi). Predefinito true.',
  'The title must be 3–120 characters': 'Il titolo deve avere 3–120 caratteri',
  'The message must be 5–8000 characters': 'Il messaggio deve avere 5–8000 caratteri',
  'Too many reports from this installation, try again later': 'Troppe segnalazioni da questa installazione, riprova più tardi',
  'GitHub cannot be reached right now, try again later': 'GitHub non è raggiungibile in questo momento, riprova più tardi',
  'GitHub did not accept the report ({0})': 'GitHub non ha accettato la segnalazione ({0})',
  'Report not found': 'Segnalazione non trovata',
  'An update is already running': 'C\'è già un aggiornamento in corso',
  'This installation was not made with git clone: update it by hand': 'Questa installazione non è stata fatta con git clone: aggiornala a mano',
  'Already up to date': 'È già aggiornato',
  'This installation has local changes to its files: update skipped': 'Questa installazione ha modifiche locali ai suoi file: aggiornamento saltato',
  'The update failed; the previous version is still installed': 'L\'aggiornamento non è riuscito; resta installata la versione precedente',
  'Get a number\'s profile': 'Profilo di un numero',
  'Read the WhatsApp profile of one of the owner\'s numbers: name (the same name WhatsOps shows), info/about text and profile photo.': 'Legge il profilo WhatsApp di uno dei numeri del proprietario: nome (lo stesso che mostra WhatsOps), info e foto profilo.',
  'Also return the profile photo as an image (default false)': 'Restituisci anche la foto profilo come immagine (predefinito false)',
  'Edit a number\'s profile': 'Modifica il profilo di un numero',
  'Change the WhatsApp profile of one of the owner\'s numbers ON WHATSAPP ITSELF (all contacts see it): name (1–25 characters, also the name in WhatsOps), info/about text (max 139) and/or profile photo (an http(s) image URL or a data: URL / base64), or remove the photo. Confirm the change with the user first.': 'Cambia il profilo WhatsApp di uno dei numeri del proprietario DIRETTAMENTE SU WHATSAPP (lo vedono tutti i contatti): nome (1–25 caratteri, è anche il nome in WhatsOps), info (max 139) e/o foto profilo (URL http(s) di un\'immagine, data: URL o base64), oppure togli la foto. Conferma prima la modifica con l\'utente.',
  'New profile name': 'Nuovo nome del profilo',
  'New info/about text (empty string clears it)': 'Nuovo testo info (stringa vuota per toglierlo)',
  'New profile photo: http(s) image URL, data: URL or base64': 'Nuova foto profilo: URL http(s) di un\'immagine, data: URL o base64',
  'Remove the profile photo': 'Togli la foto profilo',
  'Nothing to change: give a name, an info text or a photo': 'Niente da cambiare: indica un nome, un testo info o una foto',
  'The name must be 1–25 characters': 'Il nome deve avere 1–25 caratteri',
  'The info must be at most 139 characters': 'L\'info può avere al massimo 139 caratteri',
  'Send the photo as url or base64': 'Invia la foto come url o base64',
  'This number has no profile photo': 'Questo numero non ha una foto profilo',
  'The license service cannot be reached right now, try again later': 'Il servizio licenze non è raggiungibile in questo momento, riprova più tardi',
  'Licenses are not enabled: WhatsOps is free': 'Le licenze non sono attive: WhatsOps è gratuito',
  'This license key is not valid': 'Questa chiave di licenza non è valida',
  'Current RMS discussions': 'Discussioni Current RMS',
  'List the discussions of Current RMS (OnRent Events) grouped by the record they belong to (opportunity, project, contact, invoice…), with whether each one is synced with a WhatsApp group.': 'Elenca le discussioni di Current RMS (OnRent Events) raggruppate per il record a cui appartengono (opportunità, progetto, contatto, fattura…), con lo stato di sincronizzazione con un gruppo WhatsApp.',
  'Filter by record name or discussion subject': 'Filtra per nome del record o oggetto della discussione',
  'Sync a Current RMS discussion': 'Sincronizza una discussione Current RMS',
  'Turn the WhatsApp sync of a Current RMS discussion on or off. On: WhatsOps creates the WhatsApp group (or a group in the record\'s Community, per the plugin settings) and adds the participants that have a WhatsApp number; when the plugin mirrors messages for that kind of record, it also posts the whole discussion and then mirrors new messages both ways. Confirm with the user first.': 'Accende o spegne la sincronizzazione WhatsApp di una discussione Current RMS. Accesa: WhatsOps crea il gruppo WhatsApp (o un gruppo nella Community del record, secondo le impostazioni del plugin) e aggiunge i partecipanti che hanno un numero WhatsApp; se il plugin sincronizza i messaggi per quel tipo di record, pubblica anche tutta la discussione e poi riporta i nuovi messaggi nei due sensi. Chiedi prima conferma all\'utente.',
  'Discussion id (from currentrms_discussions)': 'Id della discussione (da currentrms_discussions)',
  'true = sync on, false = sync off': 'true = sincronizzazione accesa, false = spenta',
  'Connect Current RMS first (subdomain and API key)': 'Collega prima Current RMS (sottodominio e chiave API)',
  'Current RMS cannot be reached right now': 'Current RMS non è raggiungibile in questo momento',
  'Current RMS refused the subdomain or the API key': 'Current RMS ha rifiutato il sottodominio o la chiave API',
  'Current RMS answered {0}: {1}': 'Current RMS ha risposto {0}: {1}',
  'Discussion {0} not found (refresh the list)': 'Discussione {0} non trovata (aggiorna l\'elenco)',
  'WhatsApp did not create the group': 'WhatsApp non ha creato il gruppo',
  'WhatsApp did not create the community': 'WhatsApp non ha creato la community',
  'Write the full number with the country code, e.g. +39 333 123 4567': 'Scrivi il numero completo con il prefisso internazionale, es. +39 333 123 4567',
  'Another user already has this number ({0})': 'Un altro utente ha già questo numero ({0})',
  'The name is required': 'Il nome è obbligatorio',
  'User {0} not found': 'Utente {0} non trovato',
  'The user is switched off': 'L\'utente è disattivato',
  'Enabled user? Get the code on <b>your own</b> WhatsApp number.': 'Sei un utente abilitato? Ricevi il codice sul <b>tuo</b> numero WhatsApp.',
  'If {0} is enabled, the code is on its way · resend': 'Se {0} è abilitato, il codice sta arrivando · rimanda',
  'Your WhatsApp number · WhatsOps': 'Il tuo numero WhatsApp · WhatsOps',
  'Hi {0}': 'Ciao {0}',
  'Register your WhatsApp number for the Current RMS discussions of {0}: you become an administrator of the WhatsApp groups of the records you own.': 'Registra il tuo numero WhatsApp per le discussioni Current RMS di {0}: diventi amministratore dei gruppi WhatsApp dei record di cui sei proprietario.',
  'Registered number: {0}': 'Numero registrato: {0}',
  'Confirm': 'Conferma',
  'Code sent on WhatsApp to {0}.': 'Codice inviato su WhatsApp a {0}.',
  'Done: {0} is registered.': 'Fatto: {0} è registrato.',
  'Open WhatsOps': 'Apri WhatsOps',
  'You can only manage the discussions of the records you own': 'Puoi gestire solo le discussioni dei record di cui sei proprietario',
  'You are not allowed to do this': 'Non hai il permesso di farlo',
  'Current RMS user {0} not found': 'Utente Current RMS {0} non trovato',
  'This link is not valid or has expired. Ask for a new one.': 'Questo link non è valido o è scaduto. Chiedine uno nuovo.',
  '{0} is not on WhatsApp': '{0} non è su WhatsApp',
  'Current RMS users': 'Utenti Current RMS',
  'List the Current RMS users with their WhatsApp number (confirmed through their invite link, or from the contacts custom field), the records they own and their access to WhatsOps.': 'Elenca gli utenti Current RMS con il loro numero WhatsApp (confermato con il link d\'invito, o dal campo personalizzato dei contatti), i record di cui sono proprietari e il loro accesso a WhatsOps.',
  'Invite a Current RMS user': 'Invita un utente Current RMS',
  'Create the personal link (valid 14 days) where a Current RMS user registers their WhatsApp number with a code sent on WhatsApp. They then become admin of the groups of the records they own. Give the link only to that user: a new link cancels the previous one.': 'Crea il link personale (valido 14 giorni) dove un utente Current RMS registra il suo numero WhatsApp con un codice inviato su WhatsApp. Poi diventa amministratore dei gruppi dei record di cui è proprietario. Dai il link solo a quell\'utente: un nuovo link annulla il precedente.',
  'Current RMS user id (from currentrms_users)': 'Id utente Current RMS (da currentrms_users)',
  'Choose 2, 5, 15 or 30 minutes': 'Scegli 2, 5, 15 o 30 minuti',
  'Version {0} for this system is not published yet: trying again later': 'La versione {0} per questo sistema non è ancora pubblicata: riprovo più tardi',
  'Unknown record type {0}': 'Tipo di record sconosciuto: {0}',
  'Record {0} {1} not found': 'Record {0} {1} non trovato',
  'You can only manage the records you own': 'Puoi gestire solo i record di cui sei proprietario',
  'WhatsApp group of a Current RMS record': 'Gruppo WhatsApp di un record Current RMS',
  'Create the WhatsApp group of a Current RMS record (e.g. an opportunity or a product), or stop managing it (the group stays on WhatsApp). The plugin\'s main number creates it, inside the record\'s Community when the plugin uses Communities; the record\'s owner and the backup number become admins. New records get their group by themselves when the plugin settings say so. Confirm with the user first.': 'Crea il gruppo WhatsApp di un record Current RMS (es. un\'opportunità o un prodotto), oppure smette di gestirlo (il gruppo resta su WhatsApp). Lo crea il numero principale del plugin, dentro la Community del record se il plugin usa le Community; il proprietario del record e il numero di backup diventano amministratori. I nuovi record ricevono il gruppo da soli se le impostazioni del plugin lo prevedono. Chiedi prima conferma all\'utente.',
  'Record type in Current RMS': 'Tipo di record in Current RMS',
  'Record id in Current RMS (from currentrms_discussions)': 'Id del record in Current RMS (da currentrms_discussions)',
  'true = create the group, false = stop managing it': 'true = crea il gruppo, false = smetti di gestirlo',
  'Rentman projects': 'Progetti Rentman',
  'List the current and upcoming Rentman projects (or the ones matching a search) with their WhatsApp groups: state, structure, crew planned and confirmed, crew without a phone number.': 'Elenca i progetti Rentman in corso e futuri (o quelli che corrispondono a una ricerca) con i loro gruppi WhatsApp: stato, struttura, crew pianificata e confermata, crew senza numero di telefono.',
  'Filter by project name, number or id': 'Filtra per nome, numero o id del progetto',
  'WhatsApp groups of a Rentman project': 'Gruppi WhatsApp di un progetto Rentman',
  'Create the WhatsApp groups of a Rentman project (structure from the plugin settings: one group, or a Community with a group per subproject or per department) with the crew that accepted the invitation, or stop managing them (the groups stay on WhatsApp). WhatsOps then keeps the crew in line with the planning and posts the project card and its updates. Confirm with the user first.': 'Crea i gruppi WhatsApp di un progetto Rentman (struttura dalle impostazioni del plugin: un gruppo, oppure una Community con un gruppo per sottoprogetto o per reparto) con la crew che ha accettato l\'invito, oppure smette di gestirli (i gruppi restano su WhatsApp). Poi WhatsOps tiene la crew allineata alla pianificazione e pubblica la scheda del progetto e i suoi aggiornamenti. Chiedi prima conferma all\'utente.',
  'Rentman project id (from rentman_projects)': 'Id del progetto Rentman (da rentman_projects)',
  'true = create the groups, false = stop managing them': 'true = crea i gruppi, false = smetti di gestirli',
  'Connect Rentman first (API token)': 'Collega prima Rentman (token API)',
  'The country calling code has 1 to 4 digits (e.g. 39, 31, 971)': 'Il prefisso internazionale ha da 1 a 4 cifre (es. 39, 31, 971)',
  'Not a valid header name: {0}': 'Nome di header non valido: {0}',
  'WhatsOps sets the header {0} itself': 'L\'header {0} lo imposta WhatsOps',
  'The value of the header {0} is empty or not valid': 'Il valore dell\'header {0} è vuoto o non valido',
  'Paste the key, or the header as "Name: value" (one per line)': 'Incolla la chiave, oppure l\'header come "Nome: valore" (uno per riga)',
  'At most 10 extra headers': 'Al massimo 10 header aggiuntivi',
  // disappearing messages (whatsapp_set_disappearing)
  'Set disappearing messages': 'Imposta i messaggi effimeri',
  'Set the disappearing-messages duration for a chat (this posts a system notice in that chat) and/or the account default for new chats. 0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days. Confirm with the user first.': 'Imposta la durata dei messaggi effimeri di una chat (nella chat compare un avviso di sistema) e/o il predefinito del numero per le nuove chat. 0 = disattivati, 86400 = 24 ore, 604800 = 7 giorni, 7776000 = 90 giorni. Chiedi prima conferma all\'utente.',
  'Duration in seconds: 0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days': 'Durata in secondi: 0 = disattivati, 86400 = 24 ore, 604800 = 7 giorni, 7776000 = 90 giorni',
  'If true, set the account default for new chats (can be combined with chat)': 'Se true, imposta il predefinito del numero per le nuove chat (si può combinare con chat)',
  'seconds must be a non-negative integer (0 = off, 86400 = 24 hours, 604800 = 7 days, 7776000 = 90 days)': 'seconds deve essere un intero non negativo (0 = disattivati, 86400 = 24 ore, 604800 = 7 giorni, 7776000 = 90 giorni)',
  'Provide a chat, or set accountDefault to true, or both.': 'Indica una chat, oppure imposta accountDefault a true, o entrambi.',
  'Rentman cannot be reached right now': 'Rentman non è raggiungibile in questo momento',
  'Rentman refused the API token': 'Rentman ha rifiutato il token API',
  'Rentman answered {0}: {1}': 'Rentman ha risposto {0}: {1}',
  'Project {0} not found in Rentman': 'Progetto {0} non trovato in Rentman',
  'You can only manage the projects you created in Rentman': 'Puoi gestire solo i progetti che hai creato in Rentman',
  'Created by {0}': 'Creato da {0}',
  'Crew': 'Crew',
  'No crew confirmed yet': 'Ancora nessuna crew confermata',
  'Name: {0} → {1}': 'Nome: {0} → {1}',
  'Dates: {0} → {1}': 'Date: {0} → {1}',
  'Location: {0} → {1}': 'Location: {0} → {1}',
  'update': 'aggiornamento',
  'General': 'Generale',
}

/** All translatable keys (used by tests to make sure Italian covers every English string). */
export const IT_KEYS = Object.keys(IT)
