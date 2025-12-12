import { MarkdownView, Plugin, TFile, getAllTags, Notice, parseFrontMatterStringArray, TAbstractFile, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, AutoNoteMoverSettings, AutoNoteMoverSettingTab } from 'settings/settings';
import { fileMove, getTriggerIndicator, isFmDisable } from 'utils/Utils';

export default class AutoNoteMover extends Plugin {
	settings: AutoNoteMoverSettings;

	async onload() {
		await this.loadSettings();
		const folderTagPattern = this.settings.folder_tag_pattern ?? [];
		const excludedFolder = this.settings.excluded_folder ?? [];

		const fileCheck = (file: TAbstractFile, oldPath?: string, caller?: string) => {
			if (this.settings.trigger_auto_manual !== 'Automatic' && caller !== 'cmd') {
				return;
			}
			if (!(file instanceof TFile)) return;

			// The rename event with no basename change will be terminated.
			if (oldPath && oldPath.split('/').pop() === file.basename + '.' + file.extension) {
				return;
			}

			// Excluded Folder check
			const excludedFolderLength = excludedFolder.length;
			for (let i = 0; i < excludedFolderLength; i++) {
				if (
					!this.settings.use_regex_to_check_for_excluded_folder &&
					excludedFolder[i].folder &&
					file.parent.path === normalizePath(excludedFolder[i].folder)
				) {
					return;
				} else if (this.settings.use_regex_to_check_for_excluded_folder && excludedFolder[i].folder) {
					const regex = new RegExp(excludedFolder[i].folder);
					if (regex.test(file.parent.path)) {
						return;
					}
				}
			}

			const fileCache = this.app.metadataCache.getFileCache(file);
			// Disable AutoNoteMover when "AutoNoteMover: disable" is present in the frontmatter.
			if (isFmDisable(fileCache)) {
				return;
			}

			const fileName = file.basename;
			const fileFullName = file.basename + '.' + file.extension;
			const cacheTag = getAllTags(fileCache) ?? [];

			const matchesTags = (ruleTags: string[]) => {
				if (!ruleTags || ruleTags.length === 0) return true;
				if (cacheTag.length === 0) return false;
				return ruleTags.every((ruleTag) => {
					if (!ruleTag) return false;
					if (!this.settings.use_regex_to_check_for_tags) {
						return cacheTag.some((tag) => tag === ruleTag);
					}
					try {
						const regex = new RegExp(ruleTag);
						return cacheTag.some((tag) => regex.test(tag));
					} catch (error) {
						console.error(`[Auto Note Mover] Invalid tag regex "${ruleTag}".`, error);
						return false;
					}
				});
			};

			const matchesFrontmatterProperties = (frontmatterProperties: string[]) => {
				if (!frontmatterProperties || frontmatterProperties.length === 0) return true;
				if (!fileCache || !fileCache.frontmatter) return false;
				return frontmatterProperties.every((property) => {
					if (!property || !property.includes(':')) return false;
					const propertyParts = property.split(':');
					const propertyKey = propertyParts[0].trim();
					const propertyValue = propertyParts.slice(1).join(':').trim();
					if (!propertyKey || !propertyValue) return false;
					const fm = parseFrontMatterStringArray(fileCache.frontmatter, propertyKey);
					return fm ? fm.includes(propertyValue) : false;
				});
			};

			const matchesPatterns = (patterns: string[]) => {
				if (!patterns || patterns.length === 0) return true;
				return patterns.every((pattern) => {
					if (!pattern) return false;
					try {
						const regex = new RegExp(pattern);
						return regex.test(fileName);
					} catch (error) {
						console.error(`[Auto Note Mover] Invalid title regex "${pattern}".`, error);
						return false;
					}
				});
			};

			for (let i = 0; i < folderTagPattern.length; i++) {
				const settingFolder = folderTagPattern[i].folder;
				const rules = folderTagPattern[i].rules ?? [];

				for (let j = 0; j < rules.length; j++) {
					const rule = rules[j];
					const hasRule =
						(rule.tags && rule.tags.length > 0) ||
						(rule.frontmatterProperties && rule.frontmatterProperties.length > 0) ||
						(rule.patterns && rule.patterns.length > 0);

					if (!hasRule) {
						continue;
					}

					const isMatch =
						matchesTags(rule.tags) &&
						matchesFrontmatterProperties(rule.frontmatterProperties) &&
						matchesPatterns(rule.patterns);

					if (isMatch) {
						fileMove(this.app, settingFolder, fileFullName, file);
						return;
					}
				}
			}
		};

		// Show trigger indicator on status bar
		let triggerIndicator: HTMLElement;
		const setIndicator = () => {
			if (!this.settings.statusBar_trigger_indicator) return;
			triggerIndicator.setText(getTriggerIndicator(this.settings.trigger_auto_manual));
		};
		if (this.settings.statusBar_trigger_indicator) {
			triggerIndicator = this.addStatusBarItem();
			setIndicator();
			// TODO: Is there a better way?
			this.registerDomEvent(window, 'change', setIndicator);
		}

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on('create', (file) => fileCheck(file)));
			this.registerEvent(this.app.metadataCache.on('changed', (file) => fileCheck(file)));
			this.registerEvent(this.app.vault.on('rename', (file, oldPath) => fileCheck(file, oldPath)));
		});

		const moveNoteCommand = (view: MarkdownView) => {
			if (isFmDisable(this.app.metadataCache.getFileCache(view.file))) {
				new Notice('Auto Note Mover is disabled in the frontmatter.');
				return;
			}
			fileCheck(view.file, undefined, 'cmd');
		};

		this.addCommand({
			id: 'Move-the-note',
			name: 'Move the note',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) {
						moveNoteCommand(markdownView);
					}
					return true;
				}
			},
		});

		this.addCommand({
			id: 'Toggle-Auto-Manual',
			name: 'Toggle Auto-Manual',
			callback: () => {
				if (this.settings.trigger_auto_manual === 'Automatic') {
					this.settings.trigger_auto_manual = 'Manual';
					this.saveData(this.settings);
					new Notice('[Auto Note Mover]\nTrigger is Manual.');
				} else if (this.settings.trigger_auto_manual === 'Manual') {
					this.settings.trigger_auto_manual = 'Automatic';
					this.saveData(this.settings);
					new Notice('[Auto Note Mover]\nTrigger is Automatic.');
				}
				setIndicator();
			},
		});

		this.addSettingTab(new AutoNoteMoverSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		const loaded = await this.loadData();
		const mergedSettings = Object.assign({}, DEFAULT_SETTINGS, loaded);

		const normalizeRuleArray = (rules: any[]) => {
			if (!rules || rules.length === 0) {
				return [{ tags: [], frontmatterProperties: [], patterns: [] }];
			}
			return rules.map((rule) => {
				const tags = rule?.tags ?? (rule?.tag ? [rule.tag] : []);
				const frontmatterProperties =
					rule?.frontmatterProperties ?? (rule?.frontmatterProperty ? [rule.frontmatterProperty] : []);
				const patterns = rule?.patterns ?? (rule?.pattern ? [rule.pattern] : []);

				return {
					tags: (tags as string[])
						.map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
						.filter((tag) => tag.length > 0),
					frontmatterProperties: (frontmatterProperties as string[])
						.map((property) => (typeof property === 'string' ? property.trim() : ''))
						.filter((property) => property.length > 0),
					patterns: (patterns as string[])
						.map((pattern) => (typeof pattern === 'string' ? pattern.trim() : ''))
						.filter((pattern) => pattern.length > 0),
				};
			});
		};

		this.settings = {
			...mergedSettings,
			folder_tag_pattern:
				mergedSettings.folder_tag_pattern?.map((entry: any) => {
					if (entry?.rules) {
						return {
							folder: entry.folder ?? '',
							rules: normalizeRuleArray(entry.rules),
						};
					}

					return {
						folder: entry.folder ?? '',
						rules: normalizeRuleArray([
							{
								tag: entry.tag,
								frontmatterProperty: entry.frontmatterProperty,
								pattern: entry.pattern,
								tags: entry.tags,
								frontmatterProperties: entry.frontmatterProperties,
								patterns: entry.patterns,
							},
						]),
					};
				}) ?? DEFAULT_SETTINGS.folder_tag_pattern,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
