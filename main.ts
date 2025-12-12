import { MarkdownView, Plugin, TFile, getAllTags, Notice, parseFrontMatterStringArray, TAbstractFile, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, AutoNoteMoverSettings, AutoNoteMoverSettingTab, FolderRule, FolderTagPattern } from 'settings/settings';
import { fileMove, getTriggerIndicator, isFmDisable } from 'utils/Utils';

type LegacyRule = {
	tag?: string;
	frontmatterProperty?: string;
	pattern?: string;
	tags?: string[];
	frontmatterProperties?: string[];
	patterns?: string[];
};

type LegacyFolderRuleSet = {
	folder?: string;
	rules?: Array<FolderRule | LegacyRule>;
} & LegacyRule;

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
					const delimiterIndex = property.indexOf(':');
					const propertyKey = property.slice(0, delimiterIndex).trim();
					const propertyValue = property.slice(delimiterIndex + 1).trim();
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

		const normalizeRuleArray = (rules: Array<FolderRule | LegacyRule> | undefined) => {
			if (!rules || rules.length === 0) {
				return [{ tags: [], frontmatterProperties: [], patterns: [] }];
			}
			return rules.map((rule) => {
				const cleanValues = (values: string[]) =>
					values
						.map((value) => (typeof value === 'string' ? value.trim() : ''))
						.filter((value) => value.length > 0);

				let tags: string[] = [];
				if ('tags' in rule && Array.isArray(rule.tags)) {
					tags = rule.tags;
				} else if ('tag' in rule && typeof rule.tag === 'string' && rule.tag.trim().length > 0) {
					tags = [rule.tag];
				}

				let frontmatterProperties: string[] = [];
				if ('frontmatterProperties' in rule && Array.isArray(rule.frontmatterProperties)) {
					frontmatterProperties = rule.frontmatterProperties;
				} else if (
					'frontmatterProperty' in rule &&
					typeof rule.frontmatterProperty === 'string' &&
					rule.frontmatterProperty.trim().length > 0
				) {
					frontmatterProperties = [rule.frontmatterProperty];
				}

				let patterns: string[] = [];
				if ('patterns' in rule && Array.isArray(rule.patterns)) {
					patterns = rule.patterns;
				} else if ('pattern' in rule && typeof rule.pattern === 'string' && rule.pattern.trim().length > 0) {
					patterns = [rule.pattern];
				}

				return {
					tags: cleanValues(tags as string[]),
					frontmatterProperties: cleanValues(frontmatterProperties as string[]),
					patterns: cleanValues(patterns as string[]),
				};
			});
		};

		this.settings = {
			...mergedSettings,
			folder_tag_pattern:
				mergedSettings.folder_tag_pattern?.map((entry: LegacyFolderRuleSet | FolderTagPattern) => {
					if (entry?.rules) {
						return {
							folder: entry.folder ?? '',
							rules: normalizeRuleArray(entry.rules),
						};
					}

					const legacyEntry = entry as LegacyFolderRuleSet;
					return {
						folder: legacyEntry.folder ?? '',
						rules: normalizeRuleArray([
							{
								tag: legacyEntry.tag,
								frontmatterProperty: legacyEntry.frontmatterProperty,
								pattern: legacyEntry.pattern,
								tags: legacyEntry.tags,
								frontmatterProperties: legacyEntry.frontmatterProperties,
								patterns: legacyEntry.patterns,
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
