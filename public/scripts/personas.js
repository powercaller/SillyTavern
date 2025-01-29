import {
    buildAvatarList,
    characterToEntity,
    characters,
    chat,
    chat_metadata,
    default_user_avatar,
    eventSource,
    event_types,
    getRequestHeaders,
    getThumbnailUrl,
    groupToEntity,
    name1,
    name2,
    reloadCurrentChat,
    saveChatConditional,
    saveMetadata,
    saveSettingsDebounced,
    setUserName,
    this_chid,
} from '../script.js';
import { persona_description_positions, power_user } from './power-user.js';
import { getTokenCountAsync } from './tokenizers.js';
import { PAGINATION_TEMPLATE, debounce, delay, download, ensureImageFormatSupported, flashHighlight, getBase64Async, getCharIndex, onlyUnique, parseJsonFile } from './utils.js';
import { debounce_timeout } from './constants.js';
import { FILTER_TYPES, FilterHelper } from './filters.js';
import { groups, selected_group } from './group-chats.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { t } from './i18n.js';
import { openWorldInfoEditor, world_names } from './world-info.js';
import { renderTemplateAsync } from './templates.js';
import { saveMetadataDebounced } from './extensions.js';

/**
 * @typedef {object} PersonaConnection A connection between a character and a character or group entity
 * @property {'character' | 'group'} type - Type of connection
 * @property {string} id - ID of the connection (character key (avatar url), group id)
 */

/** @typedef {'chat' | 'character' | 'default'} PersonaLockType Type of the persona lock */

/**
 * @typedef {object} PersonaState
 * @property {string} avatarId - The avatar id of the persona
 * @property {boolean} default - Whether this persona is the default one for all new chats
 * @property {object} locked - An object containing the lock states
 * @property {boolean} locked.chat - Whether the persona is locked to the currently open chat
 * @property {boolean} locked.character - Whether the persona is locked to the currently open character or group
 */

const USER_AVATAR_PATH = 'User Avatars/';

let savePersonasPage = 0;
const GRID_STORAGE_KEY = 'Personas_GridView';
const DEFAULT_DEPTH = 2;
const DEFAULT_ROLE = 0;
export let user_avatar = '';
export const personasFilter = new FilterHelper(debounce(getUserAvatars, debounce_timeout.quick));

function switchPersonaGridView() {
    const state = localStorage.getItem(GRID_STORAGE_KEY) === 'true';
    $('#user_avatar_block').toggleClass('gridView', state);
}

/**
 * Returns the URL of the avatar for the given user avatar Id.
 * @param {string} avatarImg User avatar Id
 * @returns {string} User avatar URL
 */
export function getUserAvatar(avatarImg) {
    return `${USER_AVATAR_PATH}${avatarImg}`;
}

export function initUserAvatar(avatar) {
    user_avatar = avatar;
    reloadUserAvatar();
    updatePersonaUIStates();
}

/**
 * Sets a user avatar file
 * @param {string} imgfile Link to an image file
 */
export function setUserAvatar(imgfile, { toastPersonaNameChange = true } = {}) {
    user_avatar = imgfile && typeof imgfile === 'string' ? imgfile : $(this).attr('data-avatar-id');
    reloadUserAvatar();
    updatePersonaUIStates();
    selectCurrentPersona({ toastPersonaNameChange: toastPersonaNameChange });
    saveSettingsDebounced();
    $('.zoomed_avatar[forchar]').remove();
}

function reloadUserAvatar(force = false) {
    $('.mes').each(function () {
        const avatarImg = $(this).find('.avatar img');
        if (force) {
            avatarImg.attr('src', avatarImg.attr('src'));
        }

        if ($(this).attr('is_user') == 'true' && $(this).attr('force_avatar') == 'false') {
            avatarImg.attr('src', getUserAvatar(user_avatar));
        }
    });
}

/**
 * Sort the given personas
 * @param {string[]} personas - The persona names to sort
 * @returns {string[]} The sorted persona names arrray, same reference as passed in
 */
function sortPersonas(personas) {
    const option = $('#persona_sort_order').find(':selected');
    if (option.attr('value') === 'search') {
        personas.sort((a, b) => {
            const aScore = personasFilter.getScore(FILTER_TYPES.PERSONA_SEARCH, a);
            const bScore = personasFilter.getScore(FILTER_TYPES.PERSONA_SEARCH, b);
            return (aScore - bScore);
        });
    } else {
        personas.sort((a, b) => {
            const aName = String(power_user.personas[a] || a);
            const bName = String(power_user.personas[b] || b);
            return power_user.persona_sort_order === 'asc' ? aName.localeCompare(bName) : bName.localeCompare(aName);
        });
    }

    return personas;
}

/** Checks the state of the current search, and adds/removes the search sorting option accordingly */
function verifyPersonaSearchSortRule() {
    const searchTerm = personasFilter.getFilterData(FILTER_TYPES.PERSONA_SEARCH);
    const searchOption = $('#persona_sort_order option[value="search"]');
    const selector = $('#persona_sort_order');
    const isHidden = searchOption.attr('hidden') !== undefined;

    // If we have a search term, we are displaying the sorting option for it
    if (searchTerm && isHidden) {
        searchOption.removeAttr('hidden');
        selector.val(searchOption.attr('value'));
        flashHighlight(selector);
    }
    // If search got cleared, we make sure to hide the option and go back to the one before
    if (!searchTerm) {
        searchOption.attr('hidden', '');
        selector.val(power_user.persona_sort_order);
    }
}

/**
 * Gets a rendered avatar block.
 * @param {string} avatarId Avatar file name
 * @returns {JQuery<HTMLElement>} Avatar block
 */
function getUserAvatarBlock(avatarId) {
    const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
    const template = $('#user_avatar_template .avatar-container').clone();
    const personaName = power_user.personas[avatarId];
    const personaDescription = power_user.persona_descriptions[avatarId]?.description;

    template.find('.ch_name').text(personaName || '[Unnamed Persona]');
    template.find('.ch_description').text(personaDescription || $('#user_avatar_block').attr('no_desc_text')).toggleClass('text_muted', !personaDescription);
    template.attr('data-avatar-id', avatarId);
    template.find('.avatar').attr('data-avatar-id', avatarId).attr('title', avatarId);
    template.toggleClass('default_persona', avatarId === power_user.default_persona);
    let avatarUrl = getUserAvatar(avatarId);
    if (isFirefox) {
        avatarUrl += '?t=' + Date.now();
    }
    template.find('img').attr('src', avatarUrl);

    // Make sure description block has at least three rows. Otherwise height looks inconsistent. I don't have a better idea for this.
    const currentText = template.find('.ch_description').text();
    if (currentText.split('\n').length < 3) {
        template.find('.ch_description').text(currentText + '\n\xa0\n\xa0');
    }

    $('#user_avatar_block').append(template);
    return template;
}

/**
 * Gets a list of user avatars.
 * @param {boolean} doRender Whether to render the list
 * @param {string} openPageAt Item to be opened at
 * @returns {Promise<string[]>} List of avatar file names
 */
export async function getUserAvatars(doRender = true, openPageAt = '') {
    const response = await fetch('/api/avatars/get', {
        method: 'POST',
        headers: getRequestHeaders(),
    });
    if (response.ok) {
        const allEntities = await response.json();

        if (!Array.isArray(allEntities)) {
            return [];
        }

        if (!doRender) {
            return allEntities;
        }

        // Before printing the personas, we check if we should enable/disable search sorting
        verifyPersonaSearchSortRule();

        let entities = personasFilter.applyFilters(allEntities);
        entities = sortPersonas(entities);

        const storageKey = 'Personas_PerPage';
        const listId = '#user_avatar_block';
        const perPage = Number(localStorage.getItem(storageKey)) || 5;

        $('#persona_pagination_container').pagination({
            dataSource: entities,
            pageSize: perPage,
            sizeChangerOptions: [5, 10, 25, 50, 100, 250, 500, 1000],
            pageRange: 1,
            pageNumber: savePersonasPage || 1,
            position: 'top',
            showPageNumbers: false,
            showSizeChanger: true,
            prevText: '<',
            nextText: '>',
            formatNavigator: PAGINATION_TEMPLATE,
            showNavigator: true,
            callback: function (data) {
                $(listId).empty();
                for (const item of data) {
                    $(listId).append(getUserAvatarBlock(item));
                }
                updatePersonaUIStates();
            },
            afterSizeSelectorChange: function (e) {
                localStorage.setItem(storageKey, e.target.value);
            },
            afterPaging: function (e) {
                savePersonasPage = e;
            },
            afterRender: function () {
                $(listId).scrollTop(0);
            },
        });

        if (openPageAt) {
            const avatarIndex = entities.indexOf(openPageAt);
            const page = Math.floor(avatarIndex / perPage) + 1;

            if (avatarIndex !== -1) {
                $('#persona_pagination_container').pagination('go', page);
            }
        }

        return allEntities;
    }
}

/**
 * Uploads an avatar file to the server
 * @param {string} url URL for the avatar file
 * @param {string} [name] Optional name for the avatar file
 * @returns {Promise} Promise object representing the AJAX request
 */
async function uploadUserAvatar(url, name) {
    const fetchResult = await fetch(url);
    const blob = await fetchResult.blob();
    const file = new File([blob], 'avatar.png', { type: 'image/png' });
    const formData = new FormData();
    formData.append('avatar', file);

    if (name) {
        formData.append('overwrite_name', name);
    }

    return jQuery.ajax({
        type: 'POST',
        url: '/api/avatars/upload',
        data: formData,
        beforeSend: () => { },
        cache: false,
        contentType: false,
        processData: false,
        success: async function () {
            await getUserAvatars(true, name);
        },
    });
}

async function changeUserAvatar(e) {
    const form = document.getElementById('form_upload_avatar');

    if (!(form instanceof HTMLFormElement)) {
        console.error('Form not found');
        return;
    }

    const file = e.target.files[0];

    if (!file) {
        form.reset();
        return;
    }

    const formData = new FormData(form);
    const dataUrl = await getBase64Async(file);
    let url = '/api/avatars/upload';

    if (!power_user.never_resize_avatars) {
        const dlg = new Popup(t`Set the crop position of the avatar image`, POPUP_TYPE.CROP, '', { cropImage: dataUrl });
        const result = await dlg.show();

        if (!result) {
            return;
        }

        if (dlg.cropData !== undefined) {
            url += `?crop=${encodeURIComponent(JSON.stringify(dlg.cropData))}`;
        }
    }

    const rawFile = formData.get('avatar');
    if (rawFile instanceof File) {
        const convertedFile = await ensureImageFormatSupported(rawFile);
        formData.set('avatar', convertedFile);
    }

    jQuery.ajax({
        type: 'POST',
        url: url,
        data: formData,
        beforeSend: () => { },
        cache: false,
        contentType: false,
        processData: false,
        success: async function (data) {
            // If the user uploaded a new avatar, we want to make sure it's not cached
            const name = formData.get('overwrite_name');
            if (name) {
                await fetch(getUserAvatar(String(name)), { cache: 'no-cache' });
                reloadUserAvatar(true);
            }

            if (!name && data.path) {
                await getUserAvatars();
                await delay(500);
                await createPersona(data.path);
            }

            await getUserAvatars(true, name || data.path);
        },
        error: (jqXHR, exception) => { },
    });

    // Will allow to select the same file twice in a row
    form.reset();
}

/**
 * Prompts the user to create a persona for the uploaded avatar.
 * @param {string} avatarId User avatar id
 * @returns {Promise} Promise that resolves when the persona is set
 */
export async function createPersona(avatarId) {
    const personaName = await Popup.show.input(t`Enter a name for this persona:`, t`Cancel if you're just uploading an avatar.`, '');

    if (!personaName) {
        console.debug('User cancelled creating a persona');
        return;
    }

    const personaDescription = await Popup.show.input(t`Enter a description for this persona:`, t`You can always add or change it later.`, '', { rows: 4 });

    initPersona(avatarId, personaName, personaDescription);
    if (power_user.persona_show_notifications) {
        toastr.success(t`You can now pick ${personaName} as a persona in the Persona Management menu.`, t`Persona Created`);
    }
}

async function createDummyPersona() {
    const personaName = await Popup.show.input(t`Enter a name for this persona:`, null);

    if (!personaName) {
        console.debug('User cancelled creating dummy persona');
        return;
    }

    // Date + name (only ASCII) to make it unique
    const avatarId = `${Date.now()}-${personaName.replace(/[^a-zA-Z0-9]/g, '')}.png`;
    initPersona(avatarId, personaName, '');
    await uploadUserAvatar(default_user_avatar, avatarId);
}

/**
 * Initializes a persona for the given avatar id.
 * @param {string} avatarId User avatar id
 * @param {string} personaName Name for the persona
 * @param {string} personaDescription Optional description for the persona
 * @returns {void}
 */
export function initPersona(avatarId, personaName, personaDescription) {
    power_user.personas[avatarId] = personaName;
    power_user.persona_descriptions[avatarId] = {
        description: personaDescription || '',
        position: persona_description_positions.IN_PROMPT,
        depth: DEFAULT_DEPTH,
        role: DEFAULT_ROLE,
        lorebook: '',
    };

    saveSettingsDebounced();
}

export async function convertCharacterToPersona(characterId = null) {
    if (null === characterId) characterId = this_chid;

    const avatarUrl = characters[characterId]?.avatar;
    if (!avatarUrl) {
        console.log('No avatar found for this character');
        return;
    }

    const name = characters[characterId]?.name;
    let description = characters[characterId]?.description;
    const overwriteName = `${name} (Persona).png`;

    if (overwriteName in power_user.personas) {
        const confirm = await Popup.show.confirm(t`Overwrite Existing Persona`, t`This character exists as a persona already. Do you want to overwrite it?`);
        if (!confirm) {
            console.log('User cancelled the overwrite of the persona');
            return;
        }
    }

    if (description.includes('{{char}}') || description.includes('{{user}}')) {
        const confirm = await Popup.show.confirm(t`Persona Description Macros`, t`This character has a description that uses <code>{{char}}</code> or <code>{{user}}</code> macros. Do you want to swap them in the persona description?`);
        if (confirm) {
            description = description.replace(/{{char}}/gi, '{{personaChar}}').replace(/{{user}}/gi, '{{personaUser}}');
            description = description.replace(/{{personaUser}}/gi, '{{char}}').replace(/{{personaChar}}/gi, '{{user}}');
        }
    }

    const thumbnailAvatar = getThumbnailUrl('avatar', avatarUrl);
    await uploadUserAvatar(thumbnailAvatar, overwriteName);

    power_user.personas[overwriteName] = name;
    power_user.persona_descriptions[overwriteName] = {
        description: description,
        position: persona_description_positions.IN_PROMPT,
        depth: DEFAULT_DEPTH,
        role: DEFAULT_ROLE,
        lorebook: '',
    };

    // If the user is currently using this persona, update the description
    if (user_avatar === overwriteName) {
        power_user.persona_description = description;
    }

    saveSettingsDebounced();

    console.log('Persona for character created');
    toastr.success(t`You can now pick ${name} as a persona in the Persona Management menu.`, t`Persona Created`);

    // Refresh the persona selector
    await getUserAvatars(true, overwriteName);
    // Reload the persona description
    setPersonaDescription();
}

/**
 * Counts the number of tokens in a persona description.
 */
const countPersonaDescriptionTokens = debounce(async () => {
    const description = String($('#persona_description').val());
    const count = await getTokenCountAsync(description);
    $('#persona_description_token_count').text(String(count));
}, debounce_timeout.relaxed);

export function setPersonaDescription() {
    $('#your_name').text(name1);

    if (power_user.persona_description_position === persona_description_positions.AFTER_CHAR) {
        power_user.persona_description_position = persona_description_positions.IN_PROMPT;
    }

    $('#persona_depth_position_settings').toggle(power_user.persona_description_position === persona_description_positions.AT_DEPTH);
    $('#persona_description').val(power_user.persona_description);
    $('#persona_depth_value').val(power_user.persona_description_depth ?? DEFAULT_DEPTH);
    $('#persona_description_position')
        .val(power_user.persona_description_position)
        .find(`option[value="${power_user.persona_description_position}"]`)
        .attr('selected', String(true));
    $('#persona_depth_role')
        .val(power_user.persona_description_role)
        .find(`option[value="${power_user.persona_description_role}"]`)
        .prop('selected', String(true));
    $('#persona_lore_button').toggleClass('world_set', !!power_user.persona_description_lorebook);
    countPersonaDescriptionTokens();

    updatePersonaUIStates();
    updatePersonaConnectionsAvatarList();
}

/**
 * Gets a list of all personas in the current chat.
 *
 * @returns {string[]} An array of persona identifiers
 */
function getPersonasOfCurrentChat() {
    const personas = chat.filter(message => String(message.force_avatar).startsWith(USER_AVATAR_PATH))
        .map(message => message.force_avatar.replace(USER_AVATAR_PATH, ''))
        .filter(onlyUnique);
    return personas;
}

/**
 * Builds a list of persona avatars and populates the given block element with them.
 *
 * @param {HTMLElement} block - The HTML element where the avatar list will be rendered
 * @param {string[]} personas - An array of persona identifiers
 * @param {Object} [options] - Optional settings for building the avatar list
 * @param {boolean} [options.empty=true] - Whether to clear the block element before adding avatars
 * @param {boolean} [options.interactable=false] - Whether the avatars should be interactable
 * @param {boolean} [options.highlightFavs=true] - Whether to highlight favorite avatars
 */
export function buildPersonaAvatarList(block, personas, { empty = true, interactable = false, highlightFavs = true } = {}) {
    const personaEntities = personas.map(avatar => ({
        type: 'persona',
        id: avatar,
        item: {
            name: power_user.personas[avatar],
            description: power_user.persona_descriptions[avatar]?.description || '',
            avatar: avatar,
            fav: power_user.default_persona === avatar,
        },
    }));

    buildAvatarList($(block), personaEntities, { empty: empty, interactable: interactable, highlightFavs: highlightFavs });
}

/**
 * Displays avatar connections for the current persona.
 * Converts connections to entities and populates the avatar list. Shows a message if no connections are found.
 */
export function updatePersonaConnectionsAvatarList() {
    /** @type {PersonaConnection[]} */
    const connections = power_user.persona_descriptions[user_avatar]?.connections ?? [];
    const entities = connections.map(connection => {
        if (connection.type === 'character') {
            const character = characters.find(c => c.avatar === connection.id);
            if (character) return characterToEntity(character, getCharIndex(character));
        }
        if (connection.type === 'group') {
            const group = groups.find(g => g.id === connection.id);
            if (group) return groupToEntity(group);
        }
        return undefined;
    }).filter(entity => entity?.item !== undefined);

    if (entities.length)
        buildAvatarList($('#persona_connections_list'), entities);
    else
        $('#persona_connections_list').text(t`[No character connections. Click one of the buttons above to connect this persona.]`);
}


/**
 * Displays a popup for persona selection and returns the selected persona.
 *
 * @param {string} title - The title to display in the popup
 * @param {string} text - The text to display in the popup
 * @param {string[]} personas - An array of persona ids to display for selection
 * @param {Object} [options] - Optional settings for the popup
 * @param {string} [options.okButton='None'] - The label for the OK button
 * @param {(element: HTMLElement, ev: MouseEvent) => any} [options.shiftClickHandler] - A function to handle shift-click
 * @param {boolean|string[]} [options.highlightPersonas=false] - Whether to highlight personas - either by providing a list of persona keys, or true to highlight all present in current chat
 * @param {PersonaConnection} [options.targetedChar] - The targeted character or gorup for this persona selection
 * @returns {Promise<string?>} - A promise that resolves to the selected persona id or null if no selection was made
 */
export async function askForPersonaSelection(title, text, personas, { okButton = 'None', shiftClickHandler = undefined, highlightPersonas = false, targetedChar = undefined } = {}) {
    const content = document.createElement('div');
    const titleElement = document.createElement('h3');
    titleElement.textContent = title;
    content.appendChild(titleElement);

    const textElement = document.createElement('div');
    textElement.classList.add('multiline', 'm-b-1');
    textElement.textContent = text;
    content.appendChild(textElement);

    const personaListBlock = document.createElement('div');
    personaListBlock.classList.add('persona-list', 'avatars_inline', 'avatars_multiline', 'text_muted');
    content.appendChild(personaListBlock);

    if (personas.length > 0)
        buildPersonaAvatarList(personaListBlock, personas, { interactable: true });
    else
        personaListBlock.textContent = t`[Currently no personas connected]`;

    const personasToHighlight = highlightPersonas instanceof Array ? highlightPersonas : (highlightPersonas ? getPersonasOfCurrentChat() : []);

    // Make the persona blocks clickable and close the popup
    personaListBlock.querySelectorAll('.avatar[data-type="persona"]').forEach(block => {
        if (!(block instanceof HTMLElement)) return;
        block.dataset.result = String(100 + personas.indexOf(block.dataset.pid));

        if (shiftClickHandler) {
            block.addEventListener('click', function (ev) {
                if (ev.shiftKey) {
                    shiftClickHandler(this, ev);
                }
            });
        }

        if (personasToHighlight && personasToHighlight.includes(block.dataset.pid)) {
            block.classList.add('is_active');
            block.title = block.title + '\n\n' + t`Was used in current chat.`;
            if (block.classList.contains('is_fav')) block.title = block.title + '\n' + t`Is your default persona.`;
        }
    });

    /** @type {import('./popup.js').CustomPopupButton[]} */
    const customButtons = [];
    if (targetedChar) {
        customButtons.push({
            text: t`Remove All Connections`,
            result: 2,
            action: () => {
                for (const [personaId, description] of Object.entries(power_user.persona_descriptions)) {
                    /** @type {PersonaConnection[]} */
                    const connections = description.connections;
                    if (connections) {
                        power_user.persona_descriptions[personaId].connections = connections.filter(c => {
                            if (targetedChar.type == c.type && targetedChar.id == c.id) return false;
                            return true;
                        });
                    }
                }

                saveSettingsDebounced();
                updatePersonaConnectionsAvatarList();
                if (power_user.persona_show_notifications) {
                    const name = targetedChar.type == 'character' ? characters[targetedChar.id]?.name : groups[targetedChar.id]?.name;
                    toastr.info(t`All connections to ${name} have been removed.`, t`Personas Unlocked`);
                }
            },
        });
    }

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', { okButton: okButton, customButtons: customButtons });
    const result = await popup.show();
    return Number(result) >= 100 ? personas[Number(result) - 100] : null;
}

export function autoSelectPersona(name) {
    for (const [key, value] of Object.entries(power_user.personas)) {
        if (value === name) {
            console.log(`Auto-selecting persona ${key} for name ${name}`);
            setUserAvatar(key);
            return;
        }
    }
}

/**
 * Updates the name of a persona if it exists.
 * @param {string} avatarId User avatar id
 * @param {string} newName New name for the persona
 */
async function updatePersonaNameIfExists(avatarId, newName) {
    if (avatarId in power_user.personas) {
        power_user.personas[avatarId] = newName;
        console.log(`Updated persona name for ${avatarId} to ${newName}`);
    } else {
        power_user.personas[avatarId] = newName;
        power_user.persona_descriptions[avatarId] = {
            description: '',
            position: persona_description_positions.IN_PROMPT,
            depth: DEFAULT_DEPTH,
            role: DEFAULT_ROLE,
            lorebook: '',
        };
        console.log(`Created persona name for ${avatarId} as ${newName}`);
    }

    await getUserAvatars(true, avatarId);
    saveSettingsDebounced();
}

async function bindUserNameToPersona() {
    const avatarId = user_avatar;

    if (!avatarId) {
        console.warn('No avatar id found');
        return;
    }

    let personaUnbind = false;
    const existingPersona = power_user.personas[avatarId];
    const personaName = await Popup.show.input(
        t`Enter a name for this persona:`,
        t`(If empty name is provided, this will unbind the name from this avatar)`,
        existingPersona || '',
        { onClose: (p) => { personaUnbind = p.value === '' && p.result === POPUP_RESULT.AFFIRMATIVE; } });

    // If the user clicked cancel, don't do anything
    if (personaName === null && !personaUnbind) {
        return;
    }

    if (personaName && personaName.length > 0) {
        // If the user clicked ok and entered a name, bind the name to the persona
        console.log(`Binding persona ${avatarId} to name ${personaName}`);
        power_user.personas[avatarId] = personaName;
        const descriptor = power_user.persona_descriptions[avatarId];
        const isCurrentPersona = avatarId === user_avatar;

        // Create a description object if it doesn't exist
        if (!descriptor) {
            // If the user is currently using this persona, set the description to the current description
            power_user.persona_descriptions[avatarId] = {
                description: isCurrentPersona ? power_user.persona_description : '',
                position: isCurrentPersona ? power_user.persona_description_position : persona_description_positions.IN_PROMPT,
                depth: isCurrentPersona ? power_user.persona_description_depth : DEFAULT_DEPTH,
                role: isCurrentPersona ? power_user.persona_description_role : DEFAULT_ROLE,
                lorebook: isCurrentPersona ? power_user.persona_description_lorebook : '',
            };
        }

        // If the user is currently using this persona, update the name
        if (isCurrentPersona) {
            console.log(`Auto-updating user name to ${personaName}`);
            setUserName(personaName);
            await updatePersonaNameIfExists(user_avatar, personaName);
        }
    } else {
        // If the user clicked ok, but didn't enter a name, delete the persona
        console.log(`Unbinding persona ${avatarId}`);
        delete power_user.personas[avatarId];
        delete power_user.persona_descriptions[avatarId];
    }

    saveSettingsDebounced();
    await getUserAvatars(true, avatarId);
    setPersonaDescription();

    retriggerFirstMessageOnEmptyChat();
}

function selectCurrentPersona({ toastPersonaNameChange = true } = {}) {
    const personaName = power_user.personas[user_avatar];
    if (personaName) {
        const shouldAutoLock = power_user.persona_auto_lock && user_avatar !== chat_metadata['persona'];

        if (personaName !== name1) {
            console.log(`Auto-updating user name to ${personaName}`);
            setUserName(personaName, { toastPersonaNameChange: !shouldAutoLock && toastPersonaNameChange });
        }

        const descriptor = power_user.persona_descriptions[user_avatar];

        if (descriptor) {
            power_user.persona_description = descriptor.description ?? '';
            power_user.persona_description_position = descriptor.position ?? persona_description_positions.IN_PROMPT;
            power_user.persona_description_depth = descriptor.depth ?? DEFAULT_DEPTH;
            power_user.persona_description_role = descriptor.role ?? DEFAULT_ROLE;
            power_user.persona_description_lorebook = descriptor.lorebook ?? '';
        } else {
            power_user.persona_description = '';
            power_user.persona_description_position = persona_description_positions.IN_PROMPT;
            power_user.persona_description_depth = DEFAULT_DEPTH;
            power_user.persona_description_role = DEFAULT_ROLE;
            power_user.persona_description_lorebook = '';
            power_user.persona_descriptions[user_avatar] = {
                description: '',
                position: persona_description_positions.IN_PROMPT,
                depth: DEFAULT_DEPTH,
                role: DEFAULT_ROLE,
                lorebook: '',
                connections: [],
            };
        }

        setPersonaDescription();

        // Update the locked persona if setting is enabled
        if (shouldAutoLock) {
            chat_metadata['persona'] = user_avatar;
            console.log(`Auto locked persona to ${user_avatar}`);
            if (toastPersonaNameChange && power_user.persona_show_notifications) {
                toastr.success(`Persona ${personaName} selected and auto-locked to current chat`, t`Persona Selected`);
            }
            saveMetadataDebounced();
            updatePersonaUIStates();
        }

        // As the last step, inform user if the persona is only temporarily chosen
        if (power_user.persona_show_notifications) {
            const hasDifferentChatLock = !!chat_metadata['persona'] && chat_metadata['persona'] !== user_avatar;
            const hasDifferentDefaultLock = power_user.default_persona && power_user.default_persona !== user_avatar;

            if (hasDifferentChatLock || (!chat_metadata['persona'] && hasDifferentDefaultLock)) {
                const message = t`A different persona is locked to this chat, or you have a different default persona set. The currently selected persona will only be temporary, and resets on reload. Consider locking this persona to the chat if you want to permanently use it.`
                    + '<br /><br />'
                    + t`Current Persona: ${power_user.personas[user_avatar]}`
                    + (hasDifferentChatLock ? '<br />' + t`Chat persona: ${power_user.personas[chat_metadata['persona']]}` : '')
                    + (hasDifferentDefaultLock ? '<br />' + t`Default persona: ${power_user.personas[power_user.default_persona]}` : '');
                toastr.info(message, t`Temporary Persona`, { escapeHtml: false, preventDuplicates: true });
            }
        }
    }
}

/**
 * Checks if a connection is locked for the current character or group edit menu
 * @param {PersonaConnection} connection - Connection to check
 * @returns {boolean} Whether the connection is locked
 */
export function isPersonaConnectionLocked(connection) {
    return (!selected_group && connection.type === 'character' && connection.id === characters[this_chid]?.avatar)
        || (selected_group && connection.type === 'group' && connection.id === selected_group);
}

/**
 * Checks if the persona is locked
 * @param {PersonaLockType} type - Lock type
 * @returns {boolean} Whether the persona is locked
 */
export function isPersonaLocked(type = 'chat') {
    switch (type) {
        case 'default':
            return power_user.default_persona === user_avatar;
        case 'chat':
            return chat_metadata['persona'] == user_avatar;
        case 'character': {
            return !!power_user.persona_descriptions[user_avatar]?.connections?.some(isPersonaConnectionLocked);
        }
        default: throw new Error(`Unknown persona lock type: ${type}`);
    }
}

/**
 * Locks or unlocks the persona
 * @param {boolean} state Desired lock state
 * @param {PersonaLockType} type - Lock type
 * @returns {Promise<void>}
 */
export async function setPersonaLockState(state, type = 'chat') {
    return state ? await lockPersona(type) : await unlockPersona(type);
}

/**
 * Toggle the persona lock state
 * @param {PersonaLockType} type - Lock type
 * @returns {Promise<boolean>} - Whether the persona was locked
 */
export async function togglePersonaLock(type = 'chat') {
    if (isPersonaLocked(type)) {
        await unlockPersona(type);
        return false;
    } else {
        await lockPersona(type);
        return true;
    }
}

/**
 * Unlock the persona
 * @param {PersonaLockType} type - Lock type
 * @returns {Promise<void>}
 */
async function unlockPersona(type = 'chat') {
    switch (type) {
        case 'default': {
            // TODO: Make this toggle-able
            await toggleDefaultPersona(user_avatar, { quiet: true });
            break;
        }
        case 'chat': {
            if (chat_metadata['persona']) {
                console.log(`Unlocking persona ${user_avatar} from this chat`);
                delete chat_metadata['persona'];
                await saveMetadata();
                if (power_user.persona_show_notifications) {
                    toastr.info(t`Persona ${name1} is now unlocked from this chat.`, t`Persona Unlocked`);
                }
            }
            break;
        }
        case 'character': {
            /** @type {PersonaConnection[]} */
            const connections = power_user.persona_descriptions[user_avatar]?.connections;
            if (connections) {
                console.log(`Unlocking persona ${user_avatar} from this character ${name2}`);
                power_user.persona_descriptions[user_avatar].connections = connections.filter(c => !isPersonaConnectionLocked(c));
                saveSettingsDebounced();
                updatePersonaConnectionsAvatarList();
                if (power_user.persona_show_notifications) {
                    toastr.info(t`Persona ${name1} is now unlocked from character ${name2}.`, t`Persona Unlocked`);
                }
            }
            break;
        }
        default:
            throw new Error(`Unknown persona lock type: ${type}`);
    }

    updatePersonaUIStates();
}

/**
 * Lock the persona
 * @param {PersonaLockType} type - Lock type
 */
async function lockPersona(type = 'chat') {
    // First make sure that user_avatar is actually a persona
    if (!(user_avatar in power_user.personas)) {
        console.log(`Creating a new persona ${user_avatar}`);
        if (power_user.persona_show_notifications) {
            toastr.info(t`Creating a new persona for currently selected user name and avatar...`, t`Persona Not Found`);
        }
        power_user.personas[user_avatar] = name1;
        power_user.persona_descriptions[user_avatar] = {
            description: '',
            position: persona_description_positions.IN_PROMPT,
            depth: DEFAULT_DEPTH,
            role: DEFAULT_ROLE,
            lorebook: '',
            connections: [],
        };
    }

    switch (type) {
        case 'default': {
            await toggleDefaultPersona(user_avatar, { quiet: true });
            break;
        }
        case 'chat': {
            console.log(`Locking persona ${user_avatar} to this chat`);
            chat_metadata['persona'] = user_avatar;
            saveMetadataDebounced();
            if (power_user.persona_show_notifications) {
                toastr.success(t`User persona ${name1} is locked to ${name2} in this chat`, t`Persona Locked`);
            }
            break;
        }
        case 'character': {
            const newConnection = getCurrentConnectionObj();
            /** @type {PersonaConnection[]} */
            const connections = power_user.persona_descriptions[user_avatar].connections?.filter(c => !isPersonaConnectionLocked(c)) ?? [];
            if (newConnection && newConnection.id) {
                console.log(`Locking persona ${user_avatar} to this character ${name2}`);
                power_user.persona_descriptions[user_avatar].connections = [...connections, newConnection];

                const unlinkedCharacters = [];
                if (!power_user.persona_allow_multi_connections) {
                    for (const [avatarId, description] of Object.entries(power_user.persona_descriptions)) {
                        if (avatarId === user_avatar) continue;

                        const filteredConnections = description.connections?.filter(c => !(c.type === newConnection.type && c.id === newConnection.id)) ?? [];
                        if (filteredConnections.length !== description.connections?.length) {
                            description.connections = filteredConnections;
                            unlinkedCharacters.push(power_user.personas[avatarId]);
                        }
                    }
                }

                saveSettingsDebounced();
                updatePersonaConnectionsAvatarList();
                if (power_user.persona_show_notifications) {
                    let additional = '';
                    if (unlinkedCharacters.length)
                        additional += `<br /><br />${t`Unlinked existing persona${unlinkedCharacters.length > 1 ? 's' : ''}: ${unlinkedCharacters.join(', ')}`}`;
                    toastr.success(t`User persona ${name1} is locked to character ${name2}${additional}`, t`Persona Locked`, { escapeHtml: false });
                }
            }
            break;
        }
        default:
            throw new Error(`Unknown persona lock type: ${type}`);
    }

    updatePersonaUIStates();
}


async function deleteUserAvatar() {
    const avatarId = user_avatar;

    if (!avatarId) {
        console.warn('No avatar id found');
        return;
    }
    const confirm = await Popup.show.confirm(t`Delete Persona`,
        t`Are you sure you want to delete this avatar?` + '<br />' + t`All information associated with its linked persona will be lost.`);

    if (!confirm) {
        console.debug('User cancelled deleting avatar');
        return;
    }

    const request = await fetch('/api/avatars/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            'avatar': avatarId,
        }),
    });

    if (request.ok) {
        console.log(`Deleted avatar ${avatarId}`);
        delete power_user.personas[avatarId];
        delete power_user.persona_descriptions[avatarId];

        if (avatarId === power_user.default_persona) {
            toastr.warning(t`The default persona was deleted. You will need to set a new default persona.`, t`Default Persona Deleted`);
            power_user.default_persona = null;
        }

        if (avatarId === chat_metadata['persona']) {
            toastr.warning(t`The locked persona was deleted. You will need to set a new persona for this chat.`, t`Persona Deleted`);
            delete chat_metadata['persona'];
            await saveMetadata();
        }

        saveSettingsDebounced();

        // Use the existing mechanism to re-render the persona list and choose the next persona here
        await loadPersonaForCurrentChat({ doRender: true });
    }
}

function onPersonaDescriptionInput() {
    power_user.persona_description = String($('#persona_description').val());
    countPersonaDescriptionTokens();

    if (power_user.personas[user_avatar]) {
        let object = power_user.persona_descriptions[user_avatar];

        if (!object) {
            object = {
                description: power_user.persona_description,
                position: Number($('#persona_description_position').find(':selected').val()),
                depth: Number($('#persona_depth_value').val()),
                role: Number($('#persona_depth_role').find(':selected').val()),
                lorebook: '',
            };
            power_user.persona_descriptions[user_avatar] = object;
        }

        object.description = power_user.persona_description;
    }

    $(`.avatar-container[imgfile="${user_avatar}"] .ch_description`)
        .text(power_user.persona_description || $('#user_avatar_block').attr('no_desc_text'))
        .toggleClass('text_muted', !power_user.persona_description);
    saveSettingsDebounced();
}

function onPersonaDescriptionDepthValueInput() {
    power_user.persona_description_depth = Number($('#persona_depth_value').val());

    if (power_user.personas[user_avatar]) {
        const object = getOrCreatePersonaDescriptor();
        object.depth = power_user.persona_description_depth;
    }

    saveSettingsDebounced();
}

function onPersonaDescriptionDepthRoleInput() {
    power_user.persona_description_role = Number($('#persona_depth_role').find(':selected').val());

    if (power_user.personas[user_avatar]) {
        const object = getOrCreatePersonaDescriptor();
        object.role = power_user.persona_description_role;
    }

    saveSettingsDebounced();
}

/**
 * Opens a popup to set the lorebook for the current persona.
 * @param {PointerEvent} event Click event
 */
async function onPersonaLoreButtonClick(event) {
    const personaName = power_user.personas[user_avatar];
    const selectedLorebook = power_user.persona_description_lorebook;

    if (!personaName) {
        toastr.warning(t`You must bind a name to this persona before you can set a lorebook.`, t`Persona Name Not Set`);
        return;
    }

    if (event.altKey && selectedLorebook) {
        openWorldInfoEditor(selectedLorebook);
        return;
    }

    const template = $(await renderTemplateAsync('personaLorebook'));

    const worldSelect = template.find('select');
    template.find('.persona_name').text(personaName);

    for (const worldName of world_names) {
        const option = document.createElement('option');
        option.value = worldName;
        option.innerText = worldName;
        option.selected = selectedLorebook === worldName;
        worldSelect.append(option);
    }

    worldSelect.on('change', function () {
        power_user.persona_description_lorebook = String($(this).val());

        if (power_user.personas[user_avatar]) {
            const object = getOrCreatePersonaDescriptor();
            object.lorebook = power_user.persona_description_lorebook;
        }

        $('#persona_lore_button').toggleClass('world_set', !!power_user.persona_description_lorebook);
        saveSettingsDebounced();
    });

    await callGenericPopup(template, POPUP_TYPE.TEXT);
}

function onPersonaDescriptionPositionInput() {
    power_user.persona_description_position = Number(
        $('#persona_description_position').find(':selected').val(),
    );

    if (power_user.personas[user_avatar]) {
        const object = getOrCreatePersonaDescriptor();
        object.position = power_user.persona_description_position;
    }

    saveSettingsDebounced();
    $('#persona_depth_position_settings').toggle(power_user.persona_description_position === persona_description_positions.AT_DEPTH);
}

function getOrCreatePersonaDescriptor() {
    let object = power_user.persona_descriptions[user_avatar];

    if (!object) {
        object = {
            description: power_user.persona_description,
            position: power_user.persona_description_position,
            depth: power_user.persona_description_depth,
            role: power_user.persona_description_role,
            lorebook: power_user.persona_description_lorebook,
            connections: [],
        };
        power_user.persona_descriptions[user_avatar] = object;
    }
    return object;
}



async function toggleDefaultPersonaClicked(e) {
    e?.stopPropagation();
    const avatarId = $(e.currentTarget).closest('.avatar-container').find('.avatar').attr('data-avatar-id');
    if (avatarId) {
        await toggleDefaultPersona(avatarId);
    } else {
        console.warn('No avatar id found');
    }
}

/**
 * Sets a persona as the default one to be used for all new chats and unlocked existing chats
 * @param {string} avatarId The avatar id of the persona to set as the default
 * @param {object} [options] Optional arguments
 * @param {boolean} [options.quiet=false] If true, no confirmation popups will be shown
 * @returns {Promise<void>}
 */
async function toggleDefaultPersona(avatarId, { quiet: quiet = false } = {}) {
    if (!avatarId) {
        console.warn('No avatar id found');
        return;
    }

    const currentDefault = power_user.default_persona;

    if (power_user.personas[avatarId] === undefined) {
        console.warn(`No persona name found for avatar ${avatarId}`);
        toastr.warning(t`You must bind a name to this persona before you can set it as the default.`, t`Persona Name Not Set`);
        return;
    }


    if (avatarId === currentDefault) {
        if (!quiet) {
            const confirm = await Popup.show.confirm(t`Are you sure you want to remove the default persona?`, power_user.personas[avatarId]);
            if (!confirm) {
                console.debug('User cancelled removing default persona');
                return;
            }
        }

        console.log(`Removing default persona ${avatarId}`);
        if (power_user.persona_show_notifications) {
            toastr.info(t`This persona will no longer be used by default when you open a new chat.`, t`Default Persona Removed`);
        }
        delete power_user.default_persona;
    } else {
        if (!quiet) {
            const confirm = await Popup.show.confirm(t`Set Default Persona`,
                t`Are you sure you want to set \"${power_user.personas[avatarId]}\" as the default persona?`
                + '<br /><br />'
                + t`This name and avatar will be used for all new chats, as well as existing chats where the user persona is not locked.`);
            if (!confirm) {
                console.debug('User cancelled setting default persona');
                return;
            }
        }

        power_user.default_persona = avatarId;
        if (power_user.persona_show_notifications) {
            toastr.success(t`Set to ${power_user.personas[avatarId]}.This persona will be used by default when you open a new chat.`, t`Default Persona`);
        }
    }

    saveSettingsDebounced();
    await getUserAvatars(true, avatarId);
    updatePersonaUIStates();
}

/**
 * Returns an object with 3 properties that describe the state of the given persona
 *
 * - default: Whether this persona is the default one for all new chats
 * - locked: An object containing the lock states
 *   - chat: Whether the persona is locked to the currently open chat
 *   - character: Whether the persona is locked to the currently open character or group
 * @param {string} avatarId - The avatar id of the persona to get the state for
 * @returns {PersonaState} An object describing the state of the given persona
 */
function getPersonaStates(avatarId) {
    const isDefaultPersona = power_user.default_persona === avatarId;
    const hasChatLock = chat_metadata['persona'] == avatarId;

    /** @type {PersonaConnection[]} */
    const connections = power_user.persona_descriptions[avatarId]?.connections;
    const hasCharLock = !!connections?.some(c =>
        (!selected_group && c.type === 'character' && c.id === characters[this_chid]?.avatar)
        || (selected_group && c.type === 'group' && c.id === selected_group));

    return {
        avatarId: avatarId,
        default: isDefaultPersona,
        locked: {
            chat: hasChatLock,
            character: hasCharLock,
        },
    };
}

function updatePersonaUIStates() {
    // Update the persona list
    $('#user_avatar_block .avatar-container').each(function () {
        const avatarId = $(this).attr('data-avatar-id');
        const states = getPersonaStates(avatarId);
        $(this).toggleClass('default_persona', states.default);
        $(this).toggleClass('locked_to_chat', states.locked.chat);
        $(this).toggleClass('locked_to_character', states.locked.character);
        $(this).toggleClass('selected', avatarId === user_avatar);
    });

    // Buttons for the persona panel on the right
    const personaStates = getPersonaStates(user_avatar);

    $('#lock_persona_default').toggleClass('locked', personaStates.default);

    $('#lock_user_name').toggleClass('locked', personaStates.locked.chat);
    $('#lock_user_name i.icon').toggleClass('fa-lock', personaStates.locked.chat);
    $('#lock_user_name i.icon').toggleClass('fa-unlock', !personaStates.locked.chat);

    $('#lock_persona_to_char').toggleClass('locked', personaStates.locked.character);
    $('#lock_persona_to_char i.icon').toggleClass('fa-lock', personaStates.locked.character);
    $('#lock_persona_to_char i.icon').toggleClass('fa-unlock', !personaStates.locked.character);
}

async function loadPersonaForCurrentChat({ doRender = false } = {}) {
    // Cache persona list to check if they exist
    const userAvatars = await getUserAvatars(doRender);

    // Define a persona for this chat
    let chatPersona = '';

    /** @type {'chat' | 'character' | 'default' | null} */
    let connectType = null;

    // If persona is locked in chat metadata, select it
    if (chat_metadata['persona']) {
        console.log(`Using locked persona ${chat_metadata['persona']}`);
        chatPersona = chat_metadata['persona'];

        // Verify it exists
        if (!userAvatars.includes(chatPersona)) {
            console.warn('Chat-locked persona avatar not found, unlocking persona');
            delete chat_metadata['persona'];
            saveSettingsDebounced();
            chatPersona = '';
        }
        if (chatPersona) connectType = 'chat';
    }

    // Check if we have any persona connected to the current character
    if (!chatPersona) {
        const connectedPersonas = getConnectedPersonas();

        if (connectedPersonas.length > 0) {
            if (connectedPersonas.length === 1) {
                chatPersona = connectedPersonas[0];
            } else if (!power_user.persona_allow_multi_connections) {
                console.warn('More than one persona is connected to this character.Using the first available persona for this chat.');
                chatPersona = connectedPersonas[0];
            } else {
                chatPersona = await askForPersonaSelection(t`Select Persona`,
                    t`Multiple personas are connected to this character.\nSelect a persona to use for this chat.`,
                    connectedPersonas, { highlightPersonas: true, targetedChar: getCurrentConnectionObj() });
            }
        }

        if (chatPersona) connectType = 'character';
    }

    // Last check if default persona is set, select it
    if (!chatPersona && power_user.default_persona) {
        console.log(`Using default persona ${power_user.default_persona}`);
        chatPersona = power_user.default_persona;

        if (chatPersona) connectType = 'default';
    }

    // Whatever way we selected a persona, if it doesn't exist, unlock this chat
    if (chat_metadata['persona'] && !userAvatars.includes(chat_metadata['persona'])) {
        console.warn('Persona avatar not found, unlocking persona');
        delete chat_metadata['persona'];
    }

    // Default persona missing
    if (power_user.default_persona && !userAvatars.includes(power_user.default_persona)) {
        console.warn('Default persona avatar not found, clearing default persona');
        power_user.default_persona = null;
        saveSettingsDebounced();
    }

    // Persona avatar found, select it
    if (chatPersona) {
        const willAutoLock = power_user.persona_auto_lock && user_avatar !== chat_metadata['persona'];
        setUserAvatar(chatPersona, { toastPersonaNameChange: false });

        if (power_user.persona_show_notifications) {
            let message = t`Auto-selected persona based on ${connectType} connection.<br />Your messages will now be sent as ${power_user.personas[chatPersona]}.`;
            if (willAutoLock) {
                message += '<br /><br />' + t`Auto-locked this persona to current chat.`;
            }
            toastr.success(message, t`Persona Auto Selected`, { escapeHtml: false });
        }
    }

    updatePersonaUIStates();
}

/**
 * Returns an array of persona keys that are connected to the given character key.
 * If the character key is not provided, it defaults to the currently selected group or character.
 * @param {string} [characterKey] - The character key to query
 * @returns {string[]} - An array of persona keys that are connected to the given character key
 */
export function getConnectedPersonas(characterKey = undefined) {
    characterKey ??= selected_group || characters[this_chid]?.avatar;
    const connectedPersonas = Object.entries(power_user.persona_descriptions)
        .filter(([_, desc]) => desc.connections?.some(conn => conn.type === 'character' && conn.id === characterKey))
        .map(([key, _]) => key);
    return connectedPersonas;
}

/**
 * Retrieves the current connection object based on whether the current chat is with a char or a group.
 *
 * @returns {PersonaConnection} An object representing the current connection
 */

export function getCurrentConnectionObj() {
    if (selected_group)
        return { type: 'group', id: selected_group };
    if (characters[this_chid]?.avatar)
        return { type: 'character', id: characters[this_chid]?.avatar };
    return null;
}

function onBackupPersonas() {
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const filename = `personas_${timestamp}.json`;
    const data = JSON.stringify({
        'personas': power_user.personas,
        'persona_descriptions': power_user.persona_descriptions,
        'default_persona': power_user.default_persona,
    }, null, 2);

    const blob = new Blob([data], { type: 'application/json' });
    download(blob, filename, 'application/json');
}

async function onPersonasRestoreInput(e) {
    const file = e.target.files[0];

    if (!file) {
        console.debug('No file selected');
        return;
    }

    const data = await parseJsonFile(file);

    if (!data) {
        toastr.warning(t`Invalid file selected`, t`Persona Management`);
        console.debug('Invalid file selected');
        return;
    }

    if (!data.personas || !data.persona_descriptions || typeof data.personas !== 'object' || typeof data.persona_descriptions !== 'object') {
        toastr.warning(t`Invalid file format`, t`Persona Management`);
        console.debug('Invalid file selected');
        return;
    }

    const avatarsList = await getUserAvatars(false);
    const warnings = [];

    // Merge personas with existing ones
    for (const [key, value] of Object.entries(data.personas)) {
        if (key in power_user.personas) {
            warnings.push(`Persona "${key}" (${value}) already exists, skipping`);
            continue;
        }

        power_user.personas[key] = value;

        // If the avatar is missing, upload it
        if (!avatarsList.includes(key)) {
            warnings.push(`Persona image "${key}" (${value}) is missing, uploading default avatar`);
            await uploadUserAvatar(default_user_avatar, key);
        }
    }

    // Merge persona descriptions with existing ones
    for (const [key, value] of Object.entries(data.persona_descriptions)) {
        if (key in power_user.persona_descriptions) {
            warnings.push(`Persona description for "${key}" (${power_user.personas[key]}) already exists, skipping`);
            continue;
        }

        if (!power_user.personas[key]) {
            warnings.push(`Persona for "${key}" does not exist, skipping`);
            continue;
        }

        power_user.persona_descriptions[key] = value;
    }

    if (data.default_persona) {
        if (data.default_persona in power_user.personas) {
            power_user.default_persona = data.default_persona;
        } else {
            warnings.push(`Default persona "${data.default_persona}" does not exist, skipping`);
        }
    }

    if (warnings.length) {
        toastr.success(t`Personas restored with warnings. Check console for details.`, t`Persona Management`);
        console.warn(`PERSONA RESTORE REPORT\n====================\n${warnings.join('\n')}`);
    } else {
        toastr.success(t`Personas restored successfully.`, t`Persona Management`);
    }

    await getUserAvatars();
    setPersonaDescription();
    saveSettingsDebounced();
    $('#personas_restore_input').val('');
}

async function syncUserNameToPersona() {
    const confirmation = await Popup.show.confirm(t`Are you sure?`, t`All user-sent messages in this chat will be attributed to ${name1}.`);

    if (!confirmation) {
        return;
    }

    for (const mes of chat) {
        if (mes.is_user) {
            mes.name = name1;
            mes.force_avatar = getUserAvatar(user_avatar);
        }
    }

    await saveChatConditional();
    await reloadCurrentChat();
}

export function retriggerFirstMessageOnEmptyChat() {
    if (this_chid >= 0 && !selected_group && chat.length === 1) {
        $('#firstmessage_textarea').trigger('input');
    }
}

/**
 * Duplicates a persona.
 * @param {string} avatarId
 * @returns {Promise<void>}
 */
async function duplicatePersona(avatarId) {
    const personaName = power_user.personas[avatarId];

    if (!personaName) {
        toastr.warning('Chosen avatar is not a persona', t`Persona Management`);
        return;
    }

    const confirm = await Popup.show.confirm(t`Are you sure you want to duplicate this persona?`, personaName);

    if (!confirm) {
        console.debug('User cancelled duplicating persona');
        return;
    }

    const newAvatarId = `${Date.now()}-${personaName.replace(/[^a-zA-Z0-9]/g, '')}.png`;
    const descriptor = power_user.persona_descriptions[avatarId];

    power_user.personas[newAvatarId] = personaName;
    power_user.persona_descriptions[newAvatarId] = {
        description: descriptor?.description ?? '',
        position: descriptor?.position ?? persona_description_positions.IN_PROMPT,
        depth: descriptor?.depth ?? DEFAULT_DEPTH,
        role: descriptor?.role ?? DEFAULT_ROLE,
        lorebook: descriptor?.lorebook ?? '',
    };

    await uploadUserAvatar(getUserAvatar(avatarId), newAvatarId);
    await getUserAvatars(true, newAvatarId);
    saveSettingsDebounced();
}

export function initPersonas() {
    $(document).on('click', '.set_default_persona', toggleDefaultPersonaClicked);
    $('#persona_delete_button').on('click', deleteUserAvatar);
    $('#lock_persona_default').on('click', () => togglePersonaLock('default'));
    $('#lock_user_name').on('click', () => togglePersonaLock('chat'));
    $('#lock_persona_to_char').on('click', () => togglePersonaLock('character'));
    $('#create_dummy_persona').on('click', createDummyPersona);
    $('#persona_description').on('input', onPersonaDescriptionInput);
    $('#persona_description_position').on('input', onPersonaDescriptionPositionInput);
    $('#persona_depth_value').on('input', onPersonaDescriptionDepthValueInput);
    $('#persona_depth_role').on('input', onPersonaDescriptionDepthRoleInput);
    $('#persona_lore_button').on('click', onPersonaLoreButtonClick);
    $('#personas_backup').on('click', onBackupPersonas);
    $('#personas_restore').on('click', () => $('#personas_restore_input').trigger('click'));
    $('#personas_restore_input').on('change', onPersonasRestoreInput);
    $('#persona_sort_order').val(power_user.persona_sort_order).on('input', function () {
        const value = String($(this).val());
        // Save sort order, but do not save search sorting, as this is a temporary sorting option
        if (value !== 'search') power_user.persona_sort_order = value;
        getUserAvatars(true, user_avatar);
        saveSettingsDebounced();
    });
    $('#persona_grid_toggle').on('click', () => {
        const state = localStorage.getItem(GRID_STORAGE_KEY) === 'true';
        localStorage.setItem(GRID_STORAGE_KEY, String(!state));
        switchPersonaGridView();
    });

    const debouncedPersonaSearch = debounce((searchQuery) => {
        personasFilter.setFilterData(FILTER_TYPES.PERSONA_SEARCH, searchQuery);
    });

    $('#persona_search_bar').on('input', function () {
        const searchQuery = String($(this).val());
        debouncedPersonaSearch(searchQuery);
    });

    $('#sync_name_button').on('click', syncUserNameToPersona);
    $('#avatar_upload_file').on('change', changeUserAvatar);

    $(document).on('click', '#user_avatar_block .avatar-container', function () {
        const imgfile = $(this).attr('data-avatar-id');
        setUserAvatar(imgfile);

        // force firstMes {{user}} update on persona switch
        retriggerFirstMessageOnEmptyChat();
    });

    $('#persona_rename_button').click(async function () {
        const userName = String($('#your_name').val()).trim();
        setUserName(userName);
        await updatePersonaNameIfExists(user_avatar, userName);
        retriggerFirstMessageOnEmptyChat();
        // TODO: Do both binding and/or rename?
        //bindUserNameToPersona();
    });

    $(document).on('click', '#user_avatar_block .avatar_upload', function () {
        $('#avatar_upload_overwrite').val('');
        $('#avatar_upload_file').trigger('click');
    });

    $('#persona_duplicate_button').on('click', () => duplicatePersona(user_avatar));

    $('#persona_set_image_button').on('click', function () {
        if (!user_avatar) {
            console.log('no imgfile');
            return;
        }

        $('#avatar_upload_overwrite').val(user_avatar);
        $('#avatar_upload_file').trigger('click');
    });

    eventSource.on('charManagementDropdown', (target) => {
        if (target === 'convert_to_persona') {
            convertCharacterToPersona();
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, loadPersonaForCurrentChat);
    switchPersonaGridView();
}
