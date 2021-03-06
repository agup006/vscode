/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {IPluginDescription, IPointListener, IActivationEventListener, IMessage} from 'vs/platform/plugins/common/plugins';
import {Registry} from 'vs/platform/platform';
import Errors = require('vs/base/common/errors');
import env = require('vs/base/common/flags');
import * as JSONContributionRegistry from 'vs/languages/json/common/jsonContributionRegistry';
import {IJSONSchema} from 'vs/base/common/jsonSchema';
import nls = require('vs/nls');
import paths = require('vs/base/common/paths');
import Severity from 'vs/base/common/severity';

export interface IMessageCollector {
	error(message:any): void;
	warn(message:any): void;
	info(message:any): void;
}

export interface IPluginsMessageCollector {
	error(source:string, message:any): void;
	warn(source:string, message:any): void;
	info(source:string, message:any): void;
	scopeTo(source:string): IMessageCollector;
}

class ScopedMessageCollector implements IMessageCollector {
	private _scope: string;
	private _actual: IPluginsMessageCollector;

	constructor(scope:string, actual: IPluginsMessageCollector) {
		this._scope = scope;
		this._actual = actual;
	}

	public error(message:any): void {
		this._actual.error(this._scope, message);
	}

	public warn(message:any): void {
		this._actual.warn(this._scope, message);
	}

	public info(message:any): void {
		this._actual.info(this._scope, message);
	}
}

export interface IMessageHandler {
	(severity:Severity, source:string, message:string): void;
}

class PluginsMessageForwarder implements IPluginsMessageCollector {

	private _handler: IMessageHandler;

	constructor(handler: IMessageHandler) {
		this._handler = handler;
	}

	private _pushMessage(type: Severity, source: string, message: any): void {
		this._handler(
			type,
			source,
			this._ensureString(message)
		);
	}

	private _ensureString(e: any): string {
		if (e && e.message && e.stack) {
			return e.message + '\n\n' + e.stack;
		}
		return String(e);
	}

	public error(source: string, message: any): void {
		this._pushMessage(Severity.Error, source, message);
	}

	public warn(source: string, message: any): void {
		this._pushMessage(Severity.Warning, source, message);
	}

	public info(source: string, message: any): void {
		this._pushMessage(Severity.Info, source, message);
	}

	public scopeTo(source:string): IMessageCollector {
		return new ScopedMessageCollector(source, this);
	}
}

export class PluginsMessageCollector implements IPluginsMessageCollector {

	private _messages: IMessage[];

	constructor() {
		this._messages = [];
	}

	public getMessages(): IMessage[] {
		return this._messages;
	}

	private _pushMessage(type: Severity, source: string, message: any): void {
		this._messages.push({
			type: type,
			message: this._ensureString(message),
			source: source
		});
	}

	private _ensureString(e: any): string {
		if (e && e.message && e.stack) {
			return e.message + '\n\n' + e.stack;
		}
		return String(e);
	}

	public error(source: string, message: any): void {
		this._pushMessage(Severity.Error, source, message);
	}

	public warn(source: string, message: any): void {
		this._pushMessage(Severity.Warning, source, message);
	}

	public info(source: string, message: any): void {
		this._pushMessage(Severity.Info, source, message);
	}

	public scopeTo(source:string): IMessageCollector {
		return new ScopedMessageCollector(source, this);
	}
}

export function isValidPluginDescription(extensionFolderPath: string, pluginDescription:IPluginDescription, notices:string[]): boolean {
	if (!pluginDescription) {
		notices.push(nls.localize('pluginDescription.empty', "Got empty extension description"));
		return false;
	}
	if (typeof pluginDescription.publisher !== 'string') {
		notices.push(nls.localize('pluginDescription.publisher', "property `{0}` is mandatory and must be of type `string`", 'publisher'));
		return false;
	}
	if (typeof pluginDescription.name !== 'string') {
		notices.push(nls.localize('pluginDescription.name', "property `{0}` is mandatory and must be of type `string`", 'name'));
		return false;
	}
	if (!pluginDescription.engines) {
		notices.push(nls.localize('pluginDescription.engines', "property `{0}` is mandatory and must be of type `object`", 'engines'));
		return false;
	}
	if (typeof pluginDescription.engines.vscode !== 'string') {
		notices.push(nls.localize('pluginDescription.engines.vscode', "property `{0}` is mandatory and must be of type `string`", 'engines.vscode'));
		return false;
	}
	if (typeof pluginDescription.extensionDependencies !== 'undefined') {
		if (!_isStringArray(pluginDescription.extensionDependencies)) {
			notices.push(nls.localize('pluginDescription.extensionDependencies', "property `{0}` can be omitted or must be of type `string[]`", 'extensionDependencies'));
			return false;
		}
	}
	if (typeof pluginDescription.activationEvents !== 'undefined') {
		if (!_isStringArray(pluginDescription.activationEvents)) {
			notices.push(nls.localize('pluginDescription.activationEvents1', "property `{0}` can be omitted or must be of type `string[]`", 'activationEvents'));
			return false;
		}
		if (typeof pluginDescription.main === 'undefined') {
			notices.push(nls.localize('pluginDescription.activationEvents2', "properties `{0}` and `{1}` must both be specified or must both be omitted", 'activationEvents', 'main'));
			return false;
		}
	}
	if (typeof pluginDescription.main !== 'undefined') {
		if (typeof pluginDescription.main !== 'string') {
			notices.push(nls.localize('pluginDescription.main1', "property `{0}` can be omitted or must be of type `string`", 'main'));
			return false;
		} else {
			let normalizedAbsolutePath = paths.normalize(paths.join(extensionFolderPath, pluginDescription.main));

			if (normalizedAbsolutePath.indexOf(extensionFolderPath)) {
				notices.push(nls.localize('pluginDescription.main2', "Expected `main` ({0}) to be included inside extension's folder ({1}). This might make the extension non-portable.", normalizedAbsolutePath, extensionFolderPath));
				// not a failure case
			}
		}
		if (typeof pluginDescription.activationEvents === 'undefined') {
			notices.push(nls.localize('pluginDescription.main3', "properties `{0}` and `{1}` must both be specified or must both be omitted", 'activationEvents', 'main'));
			return false;
		}
	}
	return true;
}

interface IPluginDescriptionMap {
	[pluginId: string]: IPluginDescription;
}
var hasOwnProperty = Object.hasOwnProperty;
let schemaRegistry = <JSONContributionRegistry.IJSONContributionRegistry>Registry.as(JSONContributionRegistry.Extensions.JSONContribution);

export interface IExtensionPointUser<T> {
	description: IPluginDescription;
	value: T;
	collector: IMessageCollector;
}

export interface IExtensionPointHandler<T> {
	(extensions:IExtensionPointUser<T>[]): void;
}

export interface IExtensionPoint<T> {
	name: string;
	setHandler(handler: IExtensionPointHandler<T>): void;
}

export interface IPluginsRegistry {
	registerPlugins(pluginDescriptions: IPluginDescription[]): void;

	getPluginDescriptionsForActivationEvent(activationEvent:string): IPluginDescription[];
	getAllPluginDescriptions(): IPluginDescription[];
	getPluginDescription(pluginId:string): IPluginDescription;

	registerOneTimeActivationEventListener(activationEvent: string, listener:IActivationEventListener): void;
	triggerActivationEventListeners(activationEvent:string): void;

	registerExtensionPoint<T>(extensionPoint:string, jsonSchema: IJSONSchema): IExtensionPoint<T>;
	handleExtensionPoints(messageHandler:IMessageHandler): void;
}

class ExtensionPoint<T> implements IExtensionPoint<T> {

	public name:string;
	private _registry: PluginsRegistryImpl;
	private _handler: IExtensionPointHandler<T>;
	private _collector: IPluginsMessageCollector;

	constructor(name:string, registry: PluginsRegistryImpl) {
		this.name = name;
		this._registry = registry;
		this._handler = null;
		this._collector = null;
	}

	setHandler(handler: IExtensionPointHandler<T>): void {
		if (this._handler) {
			throw new Error('Handler already set!');
		}
		this._handler = handler;
		this._handle();
	}

	handle(collector:IPluginsMessageCollector): void {
		this._collector = collector;
		this._handle();
	}

	private _handle(): void {
		if (!this._handler || !this._collector) {
			return;
		}

		this._registry.registerPointListener(this.name, (descriptions: IPluginDescription[]) => {
			let users = descriptions.map((desc) => {
				return {
					description: desc,
					value: desc.contributes[this.name],
					collector: this._collector.scopeTo(desc.extensionFolderPath)
				};
			});
			this._handler(users);
		});
	}
}

interface IPointListenerEntry {
	extensionPoint: string;
	listener: IPointListener;
}

class PluginsRegistryImpl implements IPluginsRegistry {

	private _pluginsMap: IPluginDescriptionMap;
	private _pluginsArr: IPluginDescription[];
	private _activationMap: {[activationEvent:string]:IPluginDescription[];};
	private _pointListeners: IPointListenerEntry[];
	private _oneTimeActivationEventListeners: { [activationEvent:string]: IActivationEventListener[]; }
	private _extensionPoints: { [extPoint: string]: ExtensionPoint<any>; };

	constructor() {
		this._pluginsMap = {};
		this._pluginsArr = [];
		this._activationMap = {};
		this._pointListeners = [];
		this._extensionPoints = {};
		this._oneTimeActivationEventListeners = {};
	}

	public registerPointListener(point: string, handler: IPointListener): void {
		let entry = {
			extensionPoint: point,
			listener: handler
		};
		this._pointListeners.push(entry);
		this._triggerPointListener(entry, PluginsRegistryImpl._filterWithExtPoint(this.getAllPluginDescriptions(), point));
	}

	public registerExtensionPoint<T>(extensionPoint:string, jsonSchema: IJSONSchema): IExtensionPoint<T> {
		if (hasOwnProperty.call(this._extensionPoints, extensionPoint)) {
			throw new Error('Duplicate extension point: ' + extensionPoint);
		}
		let result = new ExtensionPoint<T>(extensionPoint, this);
		this._extensionPoints[extensionPoint] = result;

		(<any>schema).properties.contributes.properties[extensionPoint] = jsonSchema;
		schemaRegistry.registerSchema(schemaId, schema);

		return result;
	}

	public handleExtensionPoints(messageHandler:IMessageHandler): void {
		var collector = new PluginsMessageForwarder(messageHandler);

		Object.keys(this._extensionPoints).forEach((extensionPointName) => {
			this._extensionPoints[extensionPointName].handle(collector);
		});
	}

	private _triggerPointListener(handler: IPointListenerEntry, desc: IPluginDescription[]): void {
		// console.log('_triggerPointListeners: ' + desc.length + ' OF ' + handler.extensionPoint);
		if (!desc || desc.length === 0) {
			return;
		}
		try {
			handler.listener(desc);
		} catch(e) {
			Errors.onUnexpectedError(e);
		}
	}

	public registerPlugins(pluginDescriptions: IPluginDescription[]): void {
		for (let i = 0, len = pluginDescriptions.length; i < len; i++) {
			let pluginDescription = pluginDescriptions[i];

			if (hasOwnProperty.call(this._pluginsMap, pluginDescription.id)) {
				// No overwriting allowed!
				console.error('Plugin `' + pluginDescription.id + '` is already registered');
				continue;
			}

			this._pluginsMap[pluginDescription.id] = pluginDescription;
			this._pluginsArr.push(pluginDescription);

			if (Array.isArray(pluginDescription.activationEvents)) {
				for (let j = 0, lenJ = pluginDescription.activationEvents.length; j < lenJ; j++) {
					let activationEvent = pluginDescription.activationEvents[j];
					this._activationMap[activationEvent] = this._activationMap[activationEvent] || [];
					this._activationMap[activationEvent].push(pluginDescription);
				}
			}
		}

		for (let i = 0, len = this._pointListeners.length; i < len; i++) {
			let listenerEntry = this._pointListeners[i];
			let descriptions = PluginsRegistryImpl._filterWithExtPoint(pluginDescriptions, listenerEntry.extensionPoint);
			this._triggerPointListener(listenerEntry, descriptions);
		}
	}

	private static _filterWithExtPoint(input: IPluginDescription[], point: string): IPluginDescription[] {
		return input.filter((desc) => {
			return (desc.contributes && hasOwnProperty.call(desc.contributes, point));
		});
	}

	public getPluginDescriptionsForActivationEvent(activationEvent:string): IPluginDescription[] {
		if (!hasOwnProperty.call(this._activationMap, activationEvent)) {
			return [];
		}
		return this._activationMap[activationEvent].slice(0);
	}

	public getAllPluginDescriptions(): IPluginDescription[] {
		return this._pluginsArr.slice(0);
	}

	public getPluginDescription(pluginId:string): IPluginDescription {
		if (!hasOwnProperty.call(this._pluginsMap, pluginId)) {
			return null;
		}
		return this._pluginsMap[pluginId];
	}

	public registerOneTimeActivationEventListener(activationEvent: string, listener:IActivationEventListener): void {
		if (!hasOwnProperty.call(this._oneTimeActivationEventListeners, activationEvent)) {
			this._oneTimeActivationEventListeners[activationEvent] = [];
		}
		this._oneTimeActivationEventListeners[activationEvent].push(listener);
	}

	public triggerActivationEventListeners(activationEvent:string): void {
		if (hasOwnProperty.call(this._oneTimeActivationEventListeners, activationEvent)) {
			var listeners = this._oneTimeActivationEventListeners[activationEvent];
			delete this._oneTimeActivationEventListeners[activationEvent];

			for (let i = 0, len = listeners.length; i < len; i++) {
				let listener = listeners[i];
				try {
					listener();
				} catch(e) {
					Errors.onUnexpectedError(e);
				}
			}
		}
	}

}

function _isStringArray(arr: string[]): boolean {
	if (!Array.isArray(arr)) {
		return false;
	}
	for (var i = 0, len = arr.length; i < len; i++) {
		if (typeof arr[i] !== 'string') {
			return false;
		}
	}
	return true;
}

var Extensions = {
	PluginsRegistry: 'PluginsRegistry'
};
Registry.add(Extensions.PluginsRegistry, new PluginsRegistryImpl());
export var PluginsRegistry:IPluginsRegistry = Registry.as(Extensions.PluginsRegistry);

var schemaId = 'local://schemas/vscode-extension';
var schema : IJSONSchema = {
	default: {
		'name': '{{name}}',
		'description': '{{description}}',
		'author': '{{author}}',
		'version': '{{1.0.0}}',
		'main': '{{pathToMain}}',
		'dependencies': {}
	},
	// default: { name: '{{}}', version: '0.0.1', engines: { 'vscode': '*'}, contributes: { }},
	properties: {
		// engines: {
		// 	required: [ 'vscode' ],
		// 	properties: {
		// 		'vscode': {
		// 			type: 'string',
		// 			description: nls.localize('vscode.extension.engines.vscode', 'Specifies that this package only runs inside VSCode of the given version.'),
		// 		}
		// 	}
		// },
		publisher: {
			description: nls.localize('vscode.extension.publisher', 'The publisher of the VSCode extension.'),
			type: 'string'
		},
		activationEvents: {
			description: nls.localize('vscode.extension.activationEvents', 'Activation events for the VSCode extension.'),
			type: 'array',
			items: {
				type: 'string'
			}
		},
		extensionDependencies: {
			description: nls.localize('vscode.extension.extensionDependencies', 'Dependencies to other extensions.'),
			type: 'array',
			items: {
				type: 'string'
			}
		},
		scripts: {
			type: 'object',
			properties: {
				'vscode:prepublish': {
					description: nls.localize('vscode.extension.scripts.prepublish', 'Script executed before the package is published as a VSCode extension.'),
					type: 'string'
				}
			}
		},
		contributes: {
			description: nls.localize('vscode.extension.contributes', 'All contributions of the VSCode extension represented by this package.'),
			type: 'object',
			default: { 'languages': [{ 'id': '', 'extensions': [] }] },
			properties: {
				// languages: {
				// 	description: nls.localize('vscode.extension.contributes.languages', 'Contributes language declarations.'),
				// 	type: 'array',
				// 	default: [{ id: '', aliases: [], extensions: [] }],
				// 	items: {
				// 		type: 'object',
				// 		default: { id: '', extensions: [] },
				// 		properties: {
				// 			id: {
				// 				description: nls.localize('vscode.extension.contributes.languages.id', 'ID of the language.'),
				// 				type: 'string'
				// 			},
				// 			aliases: {
				// 				description: nls.localize('vscode.extension.contributes.languages.aliases', 'Name aliases for the language.'),
				// 				type: 'array',
				// 				items: {
				// 					type: 'string'
				// 				}
				// 			},
				// 			extensions: {
				// 				description: nls.localize('vscode.extension.contributes.languages.extensions', 'File extensions associated to the language.'),
				// 				default: ['.foo'],
				// 				type: 'array',
				// 				items: {
				// 					type: 'string'
				// 				}
				// 			},
				// 			filenames: {
				// 				description: nls.localize('vscode.extension.contributes.languages.filenames', 'File names associated to the language.'),
				// 				type: 'array',
				// 				items: {
				// 					type: 'string'
				// 				}
				// 			},
				// 			mimetypes: {
				// 				description: nls.localize('vscode.extension.contributes.languages.mimetypes', 'Mime types associated to the language.'),
				// 				type: 'array',
				// 				items: {
				// 					type: 'string'
				// 				}
				// 			},
				// 			firstLine: {
				// 				description: nls.localize('vscode.extension.contributes.languages.firstLine', 'A regular expression matching the first line of a file of the language.'),
				// 				type: 'string'
				// 			},
				// 		}
				// 	}
				// },
				// grammars: {
				// 	description: nls.localize('vscode.extension.contributes.grammars', 'Contributes textmate tokenizers.'),
				// 	type: 'array',
				// 	default: [{ id: '', extensions: [] }],
				// 	items: {
				// 		type: 'object',
				// 		default: { language: '{{id}}', scopeName: 'source.{{id}}', path: './syntaxes/{{id}}.tmLanguage.'},
				// 		properties: {
				// 			language: {
				// 				description: nls.localize('vscode.extension.contributes.grammars.language', 'Language id for which this syntax is contributed to.'),
				// 				type: 'string'
				// 			},
				// 			scopeName: {
				// 				description: nls.localize('vscode.extension.contributes.grammars.scopeName', 'Textmate scope name used by the tmLanguage file.'),
				// 				type: 'string'
				// 			},
				// 			path: {
				// 				description: nls.localize('vscode.extension.contributes.grammars.path', 'Path of the tmLanguage file. The path is relative to the extension folder and typically starts with \'./syntaxes/\'.'),
				// 				type: 'string'
				// 			}
				// 		}
				// 	}
				// },
				// themes: {
				// 	description: nls.localize('vscode.extension.contributes.themes', 'Contributes textmate color themes.'),
				// 	type: 'array',
				// 	default: [{ label: '{{label}}', uiTheme: 'vs-dark', path: './themes/{{id}}.tmTheme.'}],
				// 	items: {
				// 		type: 'object',
				// 		default: { label: '{{label}}', uiTheme: 'vs-dark', path: './themes/{{id}}.tmTheme.'},
				// 		properties: {
				// 			label: {
				// 				description: nls.localize('vscode.extension.contributes.themes.label', 'Label of the color theme as shown in the UI.'),
				// 				type: 'string'
				// 			},
				// 			uiTheme: {
				// 				description: nls.localize('vscode.extension.contributes.themes.uiTheme', 'Base theme defining the colors around the editor: \'vs\' is the light color theme, \'vs-dark\' is the dark color theme.'),
				// 				enum: [ 'vs', 'vs-dark']
				// 			},
				// 			path: {
				// 				description: nls.localize('vscode.extension.contributes.themes.path', 'Path of the tmTheme file. The path is relative to the extension folder and is typically \'./themes/themeFile.tmTheme\'.'),
				// 				type: 'string'
				// 			}
				// 		}
				// 	}
				// },
				// debuggers: {
				// 	description: nls.localize('vscode.extension.contributes.debuggers', 'Contributes debug adapters.'),
				// 	type: 'array',
				// 	default: [{ type: '', extensions: [] }],
				// 	items: {
				// 		type: 'object',
				// 		default: { type: '', program: '', runtime: '', enableBreakpointsFor: { languageIds: [ '' ] } },
				// 		properties: {
				// 			type: {
				// 				description: nls.localize('vscode.extension.contributes.debuggers.type', 'Unique identifier for this debug adapter.'),
				// 				type: 'string'
				// 			},
				// 			enableBreakpointsFor: {
				// 				description: nls.localize('vscode.extension.contributes.debuggers.enableBreakpointsFor', 'Allow breakpoints for these languages.'),
				// 				type: 'object',
				// 				properties: {
				// 					languageIds : {
				// 						description: nls.localize('vscode.extension.contributes.debuggers.enableBreakpointsFor.languageIds', 'List of languages.'),
				// 						type: 'array',
				// 						items: {
				// 							type: 'string'
				// 						}
				// 					}
				// 				}
				// 			},
				// 			program: {
				// 				description: nls.localize('vscode.extension.contributes.debuggers.program', 'Path to the debug adapter program. Path is either absolute or relative to the extension folder.'),
				// 				type: 'string'
				// 			},
				// 			runtime : {
				// 				description: nls.localize('vscode.extension.contributes.debuggers.runtime', 'Optional runtime in case the program attribute is not an executable but requires a runtime. Supported runtimes are \'node\' or \'mono\'.'),
				// 				type: 'string'
				// 			},
				// 			windows: {
				// 				description: nls.localize('vscode.extension.contributes.debuggers.windows', 'Windows specific settings.'),
				// 				type: 'object',
				// 				properties: {
				// 					runtime : {
				// 						description: nls.localize('vscode.extension.contributes.debuggers.windows.runtime', 'Runtime used for Windows.'),
				// 						type: 'string'
				// 					}
				// 				}
				// 			},
				// 			osx: {
				// 				description: nls.localize('vscode.extension.contributes.debuggers.osx', 'OS X specific settings.'),
				// 				type: 'object',
				// 				properties: {
				// 					runtime : {
				// 						description: nls.localize('vscode.extension.contributes.debuggers.osx.runtime', 'Runtime used for OSX.'),
				// 						type: 'string'
				// 					}
				// 				}
				// 			},
				// 			linux: {
				// 				description: nls.localize('vscode.extension.contributes.debuggers.linux', 'Linux specific settings.'),
				// 				type: 'object',
				// 				properties: {
				// 					runtime : {
				// 						description: nls.localize('vscode.extension.contributes.debuggers.linux.runtime', 'Runtime used for Linux.'),
				// 						type: 'string'
				// 					}
				// 				}
				// 			}
				// 		}
				// 	}
				// },
				// configuration: {
				// 	description: nls.localize('vscode.extension.contributes.configuration', 'Contributes configuration settings.'),
				// 	type: 'object',
				// 	default: { title: '', type: 'object', properties: {}},
				// 	properties: {
				// 		title: {
				// 			description: nls.localize('vscode.extension.contributes.configuration.title', 'A summary of the settings. This label will be used in the settings file as separating comment.'),
				// 			type: 'string'
				// 		},
				// 		type: {
				// 			description: nls.localize('vscode.extension.contributes.configuration.type', 'Type of the configuration, needs to be \'object\''),
				// 			enum: ['object'],
				// 		},
				// 		properties: {
				// 			description: nls.localize('vscode.extension.contributes.configuration.properties', 'Description of the configuration properties.'),
				// 			type: 'object'
				// 		}
				// 	}
				// },
				// keybindings: {
				// 	description: nls.localize('vscode.extension.contributes.keybindings', "Contributes keybindings."),
				// 	oneOf: [
				// 		{
				// 			$ref: '#/definitions/keybindingType'
				// 		},
				// 		{
				// 			type: 'array',
				// 			items: {
				// 				$ref: '#/definitions/keybindingType'
				// 			}
				// 		}
				// 	]
				// },
				// commands: {
				// 	description: nls.localize('vscode.extension.contributes.commands', "Contributes commands to the command palette."),
				// 	oneOf: [
				// 		{
				// 			$ref: '#/definitions/commandType'
				// 		},
				// 		{
				// 			type: 'array',
				// 			items: {
				// 				$ref: '#/definitions/commandType'
				// 			}
				// 		}
				// 	]
				// },
				outputChannels: {
					description: nls.localize('vscode.extension.contributes.outputChannels', "Contributes output views."),
					type: 'array',
					items: {
						type: 'string',
						description: nls.localize('vscode.extension.contributes.outputChannels', "The label of the output view."),
					}
				}
			}
		}
	},
	definitions: {
		// stringOrStringArray: {
		// 	oneOf:  [
		// 		{
		// 			type: 'string',
		// 		},
		// 		{
		// 			type: 'array',
		// 			items: {
		// 				type: 'string'
		// 			}
		// 		}
		// 	]
		// },
		// keybindingType: {
		// 	type: 'object',
		// 	default: { command: '', key: '' },
		// 	properties: {
		// 		command: {
		// 			description: nls.localize('vscode.extension.contributes.keybindings.command', 'Identifier of the command to run when keybinding is triggered.'),
		// 			type: 'string'
		// 		},
		// 		key: {
		// 			description: nls.localize('vscode.extension.contributes.keybindings.key', 'Key or key sequence (separate keys with plus-sign and sequences with space, e.g Ctrl+O and Ctrl+L L for a chord'),
		// 			type: 'string'
		// 		},
		// 		mac: {
		// 			description: nls.localize('vscode.extension.contributes.keybindings.mac', 'Mac specific key or key sequence.'),
		// 			type: 'string'
		// 		},
		// 		linux: {
		// 			description: nls.localize('vscode.extension.contributes.keybindings.linux', 'Linux specific key or key sequence.'),
		// 			type: 'string'
		// 		},
		// 		win: {
		// 			description: nls.localize('vscode.extension.contributes.keybindings.win', 'Windows specific key or key sequence.'),
		// 			type: 'string'
		// 		},
		// 		when: {
		// 			description: nls.localize('vscode.extension.contributes.keybindings.when', 'Condition when the key is active.'),
		// 			type: 'string'
		// 		}
		// 	}
		// },
		// commandType: {
		// 	type: 'object',
		// 	properties: {
		// 		command: {
		// 			description: nls.localize('vscode.extension.contributes.commandType.command', 'Identifier of the command to execute'),
		// 			type: 'string'
		// 		},
		// 		title: {
		// 			description: nls.localize('vscode.extension.contributes.commandType.title', 'Title by which the command is represented in the UI.'),
		// 			type: 'string'
		// 		},
		// 		category: {
		// 			description: nls.localize('vscode.extension.contributes.commandType.category', '(Optional) category string by the command is grouped in the UI'),
		// 			type: 'string'
		// 		}
		// 	}
		// }
	}
}

schemaRegistry.registerSchema(schemaId, schema);
schemaRegistry.addSchemaFileAssociation('/package.json', schemaId);