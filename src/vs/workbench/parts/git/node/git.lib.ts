/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';


import winjs = require('vs/base/common/winjs.base');
import extfs = require('vs/base/node/extfs');
import { guessMimeTypes, isBinaryMime } from 'vs/base/common/mime';
import objects = require('vs/base/common/objects');
import uuid = require('vs/base/common/uuid');
import nls = require('vs/nls');
import strings = require('vs/base/common/strings');
import { IRawFileStatus, IHead, ITag, IBranch, GitErrorCodes } from 'vs/workbench/parts/git/common/git';
import { detectMimesFromStream } from 'vs/base/node/mime'
import files = require('vs/platform/files/common/files');

import cp = require('child_process');
import iconv = require('iconv-lite');

export interface IExecutionResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface IGitErrorData {
	error?: Error;
	message?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	gitErrorCode?: string;
	gitCommand?: string;
}

export class GitError {

	public error: Error;
	public message: string;
	public stdout: string;
	public stderr: string;
	public exitCode: number;
	public gitErrorCode: string;
	public gitCommand: string;

	constructor(data: IGitErrorData) {
		if (data.error) {
			this.error = data.error;
			this.message = data.error.message;
		} else {
			this.error = null;
		}

		this.message = this.message || data.message || 'Git error';
		this.stdout = data.stdout || null;
		this.stderr = data.stderr || null;
		this.exitCode = data.exitCode || null;
		this.gitErrorCode = data.gitErrorCode || null;
		this.gitCommand = data.gitCommand || null;
	}

	public toString(): string {
		var result = this.message + ' ' + JSON.stringify({
			exitCode: this.exitCode,
			gitErrorCode: this.gitErrorCode,
			gitCommand: this.gitCommand,
			stdout: this.stdout,
			stderr: this.stderr
		}, null, 2);

		if (this.error) {
			result += (<any> this.error).stack;
		}

		return result;
	}
}

export interface IGitOptions {
	gitPath:string;
	tmpPath:string;
	defaultEncoding?: string;
	env?:any;
}

export class Git {

	public gitPath: string;
	public env: any;
	private tmpPath: string;
	private defaultEncoding: string;
	private outputListeners: { (output: string): void; }[];

	constructor(options: IGitOptions) {
		this.gitPath = options.gitPath;
		this.tmpPath = options.tmpPath;

		var encoding = options.defaultEncoding || 'utf8';
		this.defaultEncoding = iconv.encodingExists(encoding) ? encoding : 'utf8';

		this.env = options.env || {};
		this.outputListeners = [];
	}

	public run(cwd: string, args: string[], options: any = {}): winjs.TPromise<IExecutionResult> {
		options = objects.assign({ cwd: cwd }, options || {});
		return this.exec(args, options);
	}

	public stream(cwd: string, args: string[], options: any = {}): cp.ChildProcess {
		options = objects.assign({ cwd: cwd }, options || {});
		return this.spawn(args, options);
	}

	public open(repository: string, env: any = {}): Repository {
		return new Repository(this, repository, this.defaultEncoding, env);
	}

	public clone(repository: string, repoURL: string): winjs.TPromise<boolean> {
		return this.exec(['clone', repoURL, repository]).then(() => true, (err) => {
			return new winjs.TPromise<boolean>((c, e) => {

				// If there's any error, git will still leave the folder in the FS,
				// so we need to remove it.
				extfs.del(repository, this.tmpPath, (err) => {
					if (err) { return e(err); }
					c(true);
				});
			});
		});
	}

	public config(name: string, value: string): winjs.Promise {
		return this.exec(['config', '--global', name, value]);
	}

	private exec(args: string[], options: any = {}): winjs.TPromise<IExecutionResult> {
		var child = this.spawn(args, options);

		if (options.input) {
			child.stdin.end(options.input, 'utf8');
		}

		return winjs.TPromise.join<any>([
			new winjs.TPromise<number>((c, e) => {
				child.on('error', e);
				child.on('exit', c);
			}),
			new winjs.TPromise<string>((c) => {
				var buffer:string = '';
				child.stdout.setEncoding('utf8');
				child.stdout.on('data', (data: string) => buffer += data);
				child.stdout.on('close', () => c(buffer));
			}),
			new winjs.TPromise<string>((c) => {
				var buffer:string = '';
				child.stderr.setEncoding('utf8');
				child.stderr.on('data', (data: string) => buffer += data);
				child.stderr.on('close', () => c(buffer));
			})
		]).then<IExecutionResult>((values) => {
			var exitCode = <number> values[0];
			var stdout = <string> values[1];
			var stderr = <string> values[2];

			if (exitCode) {
				var gitErrorCode: string = null;

				if (/Authentication failed/.test(stderr)) {
					gitErrorCode = GitErrorCodes.AuthenticationFailed;
				} else if (/bad config file/.test(stderr)) {
					gitErrorCode = GitErrorCodes.BadConfigFile;
				} else if (/cannot make pipe for command substitution|cannot create standard input pipe/.test(stderr)) {
					gitErrorCode = GitErrorCodes.CantCreatePipe;
				} else if (/Repository not found/.test(stderr)) {
					gitErrorCode = GitErrorCodes.RepositoryNotFound;
				} else if (/unable to access/.test(stderr)) {
					gitErrorCode = GitErrorCodes.CantAccessRemote;
				}

				if (options.log !== false) {
					this.log(stderr);
				}

				return winjs.TPromise.wrapError<IExecutionResult>(new GitError({
					message: 'Failed to execute git',
					stdout: stdout,
					stderr: stderr,
					exitCode: exitCode,
					gitErrorCode: gitErrorCode,
					gitCommand: args[0]
				}));
			}

			return winjs.TPromise.as<IExecutionResult>({
				code: values[0],
				stdout: values[1],
				stderr: values[2]
			});
		});
	}

	public spawn(args: string[], options: any = {}): cp.ChildProcess {
		if (!this.gitPath) {
			throw new Error('git could not be found in the system.');
		}

		if (!options) {
			options = {};
		}

		if (!options.stdio && !options.input) {
			options.stdio = ['ignore', null, null]; // Unless provided, ignore stdin and leave default streams for stdout and stderr
		}

		options.env = objects.assign({}, options.env || {});
		options.env = objects.assign(options.env, this.env);
		options.env = objects.assign(options.env, {
			MONACO_REQUEST_GUID: uuid.v4().asHex(),
			VSCODE_GIT_REQUEST_ID: uuid.v4().asHex(),
			MONACO_GIT_COMMAND: args[0]
		});

		if (options.log !== false) {
			this.log(strings.format('git {0}\n', args.join(' ')));
		}

		return cp.spawn(this.gitPath, args, options);
	}

	public onOutput(listener: (output: string) => void): () => void {
		this.outputListeners.push(listener);
		return () => this.outputListeners.splice(this.outputListeners.indexOf(listener), 1);
	}

	private log(output: string): void {
		this.outputListeners.forEach(l => l(output));
	}
}

export class Repository {

	private git: Git;
	private repository: string;
	private defaultEncoding: string;
	private env: any;

	constructor(git: Git, repository: string, defaultEncoding: string, env: any = {}) {
		this.git = git;
		this.repository = repository;
		this.defaultEncoding = defaultEncoding;
		this.env = env;
	}

	public get path(): string {
		return this.repository;
	}

	public run(args: string[], options: any = {}): winjs.TPromise<IExecutionResult> {
		options.env = objects.assign({}, options.env || {});
		options.env = objects.assign(options.env, this.env);

		return this.git.run(this.repository, args, options);
	}

	public stream(args: string[], options: any = {}): cp.ChildProcess {
		options.env = objects.assign({}, options.env || {});
		options.env = objects.assign(options.env, this.env);

		return this.git.stream(this.repository, args, options);
	}

	public spawn(args: string[], options: any = {}): cp.ChildProcess {
		options.env = objects.assign({}, options.env || {});
		options.env = objects.assign(options.env, this.env);

		return this.git.spawn(args, options);
	}

	public init(): winjs.Promise {
		return this.run(['init']);
	}

	public config(scope: string, key:string, value:any, options:any): winjs.TPromise<string> {
		var args = ['config'];

		if (scope) {
			args.push('--' + scope);
		}

		args.push(key);

		if (value) {
			args.push(value);
		}

		return this.run(args, options).then((result) => result.stdout);
	}

	public show(object: string): cp.ChildProcess {
		return this.stream(['show', object]);
	}

	public buffer(object: string): winjs.TPromise<string> {
		var child = this.show(object);

		return new winjs.Promise((c, e) => {
			detectMimesFromStream(child.stdout, null, (err, result) => {
				if (err) {
					e(err);
				} else if (isBinaryMime(result.mimes)) {
					e(<files.IFileOperationResult>{
						message: nls.localize('fileBinaryError', "File seems to be binary and cannot be opened as text"),
						fileOperationResult: files.FileOperationResult.FILE_IS_BINARY
					});
				} else {
					c(this.doBuffer(object));
				}
			});
		});
	}

	private doBuffer(object: string): winjs.TPromise<string> {
		var child = this.show(object);

		return winjs.TPromise.join<any>([
			new winjs.TPromise<number>((c, e) => {
				child.on('error', e);
				child.on('exit', c);
			}),
			new winjs.TPromise<string>((c) => {
				var buffers: NodeBuffer[] = [];
				child.stdout.on('data', (b: NodeBuffer) => buffers.push(b));
				child.stdout.on('close', () => c(iconv.decode(Buffer.concat(buffers), this.defaultEncoding)));
			}),
			new winjs.Promise((c) => {
				child.stderr.on('data', (data:string) => { /* Read to free buffer but do not handle */ });
				child.stderr.on('close', () => c(null));
			})
		]).then((values) => {
			var exitCode = <number> values[0];
			var result = <string> values[1];

			if (exitCode) {
				return winjs.TPromise.wrapError<string>(new GitError({
					message: 'Could not buffer object.',
					exitCode: exitCode
				}));
			}

			return winjs.TPromise.as<string>(result);
		});
	}

	public add(paths: string[]): winjs.Promise {
		var args = ['add', '-A', '--'];

		if (paths && paths.length) {
			args.push.apply(args, paths);
		} else {
			args.push('.');
		}

		return this.run(args);
	}

	public stage(path: string, data: string): winjs.Promise {
		var child = this.stream(['hash-object', '--stdin', '-w'], { stdio: [null, null, null] });
		child.stdin.end(data, 'utf8');

		return winjs.TPromise.join<any>([
			new winjs.TPromise<number>((c, e) => {
				child.on('error', e);
				child.on('exit', c);
			}),
			new winjs.TPromise<string>((c) => {
				var id = '';
				child.stdout.setEncoding('utf8');
				child.stdout.on('data', (data:string) => id += data);
				child.stdout.on('close', () => c(id));
			}),
			new winjs.Promise((c) => {
				child.stderr.on('data', (data:string) => { /* Read to free buffer but do not handle */ });
				child.stderr.on('close', () => c(null));
			})
		]).then<IExecutionResult>((values) => {
			var exitCode = <number> values[0];
			var id = <string> values[1];

			if (exitCode) {
				return winjs.TPromise.wrapError<IExecutionResult>(new GitError({
					message: 'Could not hash object.',
					exitCode: exitCode
				}));
			}

			return this.run(['update-index', '--cacheinfo', '100644', id, path]);
		});
	}

	public checkout(treeish: string, paths: string[]): winjs.Promise {
		var args = [ 'checkout', '-q' ];

		if (treeish) {
			args.push(treeish);
		}

		if (paths && paths.length) {
			args.push('--');
			args.push.apply(args, paths);
		}

		return this.run(args).then(null, (err: GitError) => {
			if (/Please, commit your changes or stash them/.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.DirtyWorkTree;
			}

			return winjs.Promise.wrapError(err);
		});
	}

	public commit(message: string, all: boolean, amend: boolean): winjs.Promise {
		var args = ['commit', '--quiet', '--allow-empty-message', '--file', '-'];

		if (all) {
			args.push('--all');
		}

		if (amend) {
			args.push('--amend');
		}

		return this.run(args, { input: message || '' }).then(null, (commitErr: GitError) => {
			if (/not possible because you have unmerged files/.test(commitErr.stderr)) {
				commitErr.gitErrorCode = GitErrorCodes.UnmergedChanges;
				return winjs.Promise.wrapError(commitErr);
			}

			return this.run(['config', '--get-all', 'user.name']).then(null, (err: GitError) => {
				err.gitErrorCode = GitErrorCodes.NoUserNameConfigured;
				return winjs.Promise.wrapError(err);
			}).then(() => {
				return this.run(['config', '--get-all', 'user.email']).then(null, (err: GitError) => {
					err.gitErrorCode = GitErrorCodes.NoUserEmailConfigured;
					return winjs.Promise.wrapError(err);
				}).then(() => {
					return winjs.Promise.wrapError(commitErr);
				});
			});
		});
	}

	public branch(name: string, checkout: boolean): winjs.Promise {
		var args = checkout ? ['checkout', '-q', '-b', name] : [ 'branch', '-q', name ];
		return this.run(args);
	}

	public clean(paths: string[]): winjs.Promise {
		var args = [ 'clean', '-f', '-q', '--' ].concat(paths);
		return this.run(args);
	}

	public undo(): winjs.Promise {
		return this.run([ 'clean', '-fd' ]).then(() => {
			return this.run([ 'checkout', '--', '.' ]).then(null, (err: GitError) => {
				if (/did not match any file\(s\) known to git\./.test(err.stderr)) {
					return winjs.Promise.as(null);
				}

				return winjs.Promise.wrapError(err);
			});
		});
	}

	public reset(treeish: string, hard: boolean = false): winjs.Promise {
		var args = ['reset'];

		if (hard) {
			args.push('--hard');
		}

		args.push(treeish);

		return this.run(args);
	}

	public revertFiles(treeish: string, paths: string[]): winjs.Promise {
		return this.run([ 'branch' ]).then((result) => {
			var args: string[];

			// In case there are no branches, we must use rm --cached
			if (!result.stdout) {
				args = [ 'rm', '--cached', '-r', '--' ];
			} else {
				args = [ 'reset', '-q', treeish, '--' ];
			}

			if (paths && paths.length) {
				args.push.apply(args, paths);
			} else {
				args.push('.');
			}

			return this.run(args).then(null, (err: GitError) => {
				// In case there are merge conflicts to be resolved, git reset will output
				// some "needs merge" data. We try to get around that.
				if (/([^:]+: needs merge\n)+/m.test(err.stdout)) {
					return winjs.Promise.as(null);
				}

				return winjs.Promise.wrapError(err);
			});
		});
	}

	public fetch(): winjs.Promise {
		return this.run(['fetch']).then(null, (err: GitError) => {
			if (/No remote repository specified\./.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.NoRemoteRepositorySpecified;
			} else if (/Not a git repository/.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.NotAGitRepository;
			} else if (/Could not read from remote repository/.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
			}

			return winjs.Promise.wrapError(err);
		});
	}

	public pull(): winjs.Promise {
		return this.run(['pull']).then(null, (err: GitError) => {
			if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout)) {
				err.gitErrorCode = GitErrorCodes.Conflict;
			} else if (/Please tell me who you are\./.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.NoUserNameConfigured;
			} else if (/Could not read from remote repository/.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
			} else if (/Pull is not possible because you have unmerged files|Cannot pull with rebase: You have unstaged changes|Your local changes to the following files would be overwritten|Please, commit your changes before you can merge/.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.DirtyWorkTree;
			}

			return winjs.Promise.wrapError(err);
		});
	}

	public push(): winjs.Promise {
		return this.run(['push']).then(null, (err: GitError) => {
			if (/^error: failed to push some refs to\b/m.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.PushRejected;
			} else if (/Could not read from remote repository/.test(err.stderr)) {
				err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
			}

			return winjs.Promise.wrapError(err);
		});
	}

	public sync(): winjs.Promise {
		return this.pull().then(() => this.push());
	}

	public getRoot(): winjs.TPromise<string> {
		return this.run(['rev-parse', '--show-toplevel'], { log: false }).then(result => result.stdout.trim());
	}

	public getStatus(): winjs.TPromise<IRawFileStatus[]> {
		return this.run(['status', '-z', '-u'], { log: false }).then((executionResult) => {
			var status = executionResult.stdout;
			var result:IRawFileStatus[] = [];
			var current:IRawFileStatus;
			var i = 0;

			function readName():string {
				var start = i, c:string;
				while ((c = status.charAt(i)) !== '\u0000') { i++; }
				return status.substring(start, i++);
			}

			while (i < status.length) {
				current = {
					x: status.charAt(i++),
					y: status.charAt(i++),
					path: null,
					mimetype: null
				};

				i++;

				if (current.x === 'R') {
					current.rename = readName();
				}

				current.path = readName();
				current.mimetype = guessMimeTypes(current.path)[0];

				// If path ends with slash, it must be a nested git repo
				if (current.path[current.path.length-1] === '/') {
					continue;
				}

				result.push(current);
			}

			return winjs.TPromise.as<IRawFileStatus[]>(result);
		});
	}

	public getHEAD(): winjs.TPromise<IHead> {
		return this.run(['symbolic-ref', '--short', 'HEAD'], { log: false }).then((result) => {
			if (!result.stdout) {
				return winjs.TPromise.wrapError<IHead>(new Error('Not in a branch'));
			}

			return winjs.TPromise.as<IHead>({ name: result.stdout.trim() });
		}, (err) => {
			return this.run(['rev-parse', 'HEAD'], { log: false }).then((result) => {
				if (!result.stdout) {
					return winjs.TPromise.wrapError<IHead>(new Error('Error parsing HEAD'));
				}

				return winjs.TPromise.as<IHead>({ commit: result.stdout.trim() });
			});
		});
	}

	public getHeads(): winjs.TPromise<ITag[]> {
		return this.run(['for-each-ref', '--format', '%(refname:short) %(objectname)', 'refs/heads/'], { log: false }).then((result) => {
			return result.stdout.trim().split('\n')
				.filter(b => !!b)
				.map(b => b.trim().split(' '))
				.map(a => ({ name: a[0], commit: a[1] }));
		});
	}

	public getTags(): winjs.TPromise<IHead[]> {
		return this.run(['for-each-ref', '--format', '%(refname:short) %(objectname)', 'refs/tags/'], { log: false }).then((result) => {
			return result.stdout.trim().split('\n')
				.filter(b => !!b)
				.map(b => b.trim().split(' '))
				.map(a => ({ name: a[0], commit: a[1] }));
		});
	}

	public getBranch(branch: string): winjs.TPromise<IBranch> {
		if (branch === 'HEAD') {
			return this.getHEAD();
		}

		return this.run(['rev-parse', branch], { log: false }).then((result) => {
			if (!result.stdout) {
				return winjs.TPromise.wrapError<IBranch>(new Error('No such branch'));
			}

			var commit = result.stdout.trim();

			return this.run(['rev-parse', '--symbolic-full-name', '--abbrev-ref', branch + '@{u}'], { log: false }).then((result: IExecutionResult) => {
				var upstream = result.stdout.trim();

				return this.run(['rev-list', '--left-right', branch + '...' + upstream], { log: false }).then((result) => {
					var ahead = 0, behind = 0;
					var i = 0;

					while (i < result.stdout.length) {
						switch (result.stdout.charAt(i)) {
							case '<': ahead++; break;
							case '>': behind++; break;
							default: i++; break;
						}

						while (result.stdout.charAt(i++) !== '\n') { /* no-op */ }
					}

					return {
						name: branch,
						commit: commit,
						upstream: upstream,
						ahead: ahead,
						behind: behind
					};
				});
			}, () => {
				return { name: branch, commit: commit };
			});
		});
	}

	public onOutput(listener: (output: string) => void): () => void {
		return this.git.onOutput(listener);
	}
}