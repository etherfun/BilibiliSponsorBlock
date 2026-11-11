import * as React from "react";

import Config from "../../config";
import { setCategorySelection } from "../../config/categoryConfig";
import * as CompileConfig from "../../../config.json";
import { Category, CategorySkipOption, DynamicSponsorOption } from "../../types";

import { getCategorySuffix } from "../../utils/categoryUtils";
import ToggleOptionComponent from "./ToggleOptionComponent";

export interface CategorySkipOptionsProps {
    category: Category;
    defaultColor?: string;
    defaultPreviewColor?: string;
    children?: React.ReactNode;
}

export interface CategorySkipOptionsState {
    color: string;
    previewColor?: string;
}

export interface ToggleOption {
    configKey: string;
    label: string;
    dontDisable?: boolean;
}

/** 类别行下方挂载的附加设置：布尔开关或数字输入。 */
export type ExtraOption =
    | { type: "toggle"; configKey: string; label: string }
    | { type: "number"; configKey: string; label: string; step: number; min: number; max: number };

class CategorySkipOptionsComponent extends React.Component<CategorySkipOptionsProps, CategorySkipOptionsState> {
    setBarColorTimeout: NodeJS.Timeout;

    constructor(props: CategorySkipOptionsProps) {
        super(props);

        // Setup state
        this.state = {
            color: props.defaultColor || Config.config.barTypes[this.props.category]?.color,
            previewColor: props.defaultPreviewColor || Config.config.barTypes["preview-" + this.props.category]?.color,
        };
    }

    render(): React.ReactElement {
        let defaultOption = "disable";
        // Set the default opton properly
        for (const categorySelection of Config.config.categorySelections) {
            if (categorySelection.name === this.props.category) {
                switch (categorySelection.option) {
                    case CategorySkipOption.ShowOverlay:
                        defaultOption = "showOverlay";
                        break;
                    case CategorySkipOption.ManualSkip:
                        defaultOption = "manualSkip";
                        break;
                    case CategorySkipOption.AutoSkip:
                        defaultOption = "autoSkip";
                        break;
                }

                break;
            }
        }

        return (
            <>
                <tr id={this.props.category + "OptionsRow"} className={`categoryTableElement`}>
                    <td id={this.props.category + "OptionName"} className="categoryTableLabel">
                        {chrome.i18n.getMessage("category_" + this.props.category)}
                    </td>

                    <td className="categoryInlineDescription">
                        <div>{this.renderDescription()}</div>
                    </td>

                    <td id={this.props.category + "SkipOption"} className="skipOption">
                        <select
                            className="optionsSelector"
                            defaultValue={defaultOption}
                            onChange={this.skipOptionSelected.bind(this)}
                        >
                            {this.getCategorySkipOptions()}
                        </select>
                    </td>

                    <td id={this.props.category + "ColorOption"} className="colorOption" data-label={chrome.i18n.getMessage("seekBarColor")}>
                        <input
                            className="categoryColorTextBox option-text-box"
                            type="color"
                            aria-label={chrome.i18n.getMessage("seekBarColor")}
                            onChange={(event) => this.setColorState(event, false)}
                            value={this.state.color}
                        />
                    </td>

                    {!["exclusive_access"].includes(this.props.category) && (
                        <td id={this.props.category + "PreviewColorOption"} className="previewColorOption" data-label={chrome.i18n.getMessage("previewColor")}>
                            <input
                                className="categoryColorTextBox option-text-box"
                                type="color"
                                aria-label={chrome.i18n.getMessage("previewColor")}
                                onChange={(event) => this.setColorState(event, true)}
                                value={this.state.previewColor}
                            />
                        </td>
                    )}
                </tr>

                <tr
                    id={this.props.category + "DescriptionRow"}
                    className={`small-description categoryTableDescription`}
                >
                    <td colSpan={2}>
                        {this.renderDescription()}
                    </td>
                </tr>

                {this.getExtraOptionComponents(this.props.category)}
            </>
        );
    }

    renderDescription(): JSX.Element {
        const description = chrome.i18n.getMessage("category_" + this.props.category + "_description");
        return <><span title={description}>{description}</span>{" "}
            <a href={CompileConfig.wikiLinks[this.props.category]} target="_blank" rel="noreferrer">
                {chrome.i18n.getMessage("LearnMore")}
            </a></>;
    }

    skipOptionSelected(event: React.ChangeEvent<HTMLSelectElement>): void {
        let option: CategorySkipOption;

        switch (event.target.value) {
            case "disable":
                option = CategorySkipOption.Disabled;
                break;
            case "showOverlay":
                option = CategorySkipOption.ShowOverlay;

                break;
            case "manualSkip":
                option = CategorySkipOption.ManualSkip;

                break;
            case "autoSkip":
                option = CategorySkipOption.AutoSkip;

                if (this.props.category === "filler" && !Config.config.isVip) {
                    if (!confirm(chrome.i18n.getMessage("FillerWarning"))) {
                        event.target.value = "disable";
                    }
                }

                break;
        }

        Config.config.categorySelections = setCategorySelection(Config.config.categorySelections, this.props.category, option);
    }

    getCategorySkipOptions(): JSX.Element[] {
        const elements: JSX.Element[] = [];

        let optionNames = ["disable", "showOverlay", "manualSkip", "autoSkip"];
        if (this.props.category === "exclusive_access") optionNames = ["disable", "showOverlay"];

        for (const optionName of optionNames) {
            elements.push(
                <option key={optionName} value={optionName}>
                    {chrome.i18n.getMessage(
                        optionName !== "disable" ? optionName + getCategorySuffix(this.props.category) : optionName
                    )}
                </option>
            );
        }

        return elements;
    }

    setColorState(event: React.FormEvent<HTMLInputElement>, preview: boolean): void {
        clearTimeout(this.setBarColorTimeout);

        if (preview) {
            this.setState({
                previewColor: event.currentTarget.value,
            });

            Config.config.barTypes["preview-" + this.props.category].color = event.currentTarget.value;
        } else {
            this.setState({
                color: event.currentTarget.value,
            });

            Config.config.barTypes[this.props.category].color = event.currentTarget.value;
        }

        // Make listener get called
        this.setBarColorTimeout = setTimeout(() => {
            Config.config.barTypes = Config.config.barTypes;
        }, 50);
    }

    getExtraOptionComponents(category: string): JSX.Element[] {
        const result = [];
        for (const option of this.getExtraOptions(category)) {
            result.push(
                <tr key={option.configKey}>
                    <td id={`${category}_${option.configKey}`} className="categoryExtraOptions" colSpan={5}>
                        <ToggleOptionComponent
                            configKey={option.configKey}
                            label={option.label}
                            style={{ width: "inherit" }}
                        />
                    </td>
                </tr>
            );
        }

        return result;
    }

    getExtraOptions(category: string): ToggleOption[] {
        switch (category) {
            case "music_offtopic":
                return [
                    {
                        configKey: "autoSkipOnMusicVideos",
                        label: chrome.i18n.getMessage("autoSkipOnMusicVideos"),
                    },
                ];
            default:
                return [];
        }
    }
}

class DynamicSponsorHideOptionsComponent extends React.Component<CategorySkipOptionsProps, CategorySkipOptionsState> {
    setBarColorTimeout: NodeJS.Timeout;

    constructor(props: CategorySkipOptionsProps) {
        super(props);

        // Setup state
        this.state = {
            color: props.defaultColor || Config.config.dynamicSponsorTypes[this.props.category]?.color
        };
    }

    render(): React.ReactElement {
        let defaultOption = "disable";
        // Set the default opton properly
        for (const categorySelection of Config.config.dynamicSponsorSelections) {
            if (categorySelection.name === this.props.category) {
                switch (categorySelection.option) {
                    case DynamicSponsorOption.ShowOverlay:
                        defaultOption = "showOverlay_DynamicSponsor";
                        break;
                    case DynamicSponsorOption.Hide:
                        defaultOption = "Hide_DynamicSponsor";
                        break;
                    case DynamicSponsorOption.HideCard:
                        defaultOption = "HideCard_DynamicSponsor";
                        break;
                }

                break;
            }
        }

        return (
            <>
                <tr id={this.props.category + "OptionsRow"} className={`categoryTableElement`}>
                    <td id={this.props.category + "OptionName"} className="categoryTableLabel">
                        {chrome.i18n.getMessage("category_" + this.props.category)}
                    </td>

                    <td className="categoryInlineDescription">
                        {chrome.i18n.getMessage("category_" + this.props.category + "_description")}
                    </td>

                    <td id={this.props.category + "SkipOption"} className="skipOption">
                        <select
                            className="optionsSelector"
                            defaultValue={defaultOption}
                            onChange={this.skipOptionSelected.bind(this)}
                        >
                            {this.getCategorySkipOptions()}
                        </select>
                    </td>

                    <td id={this.props.category + "ColorOption"} className="colorOption">
                        <input
                            className="categoryColorTextBox option-text-box"
                            type="color"
                            onChange={(event) => this.setColorState(event)}
                            value={this.state.color}
                        />
                    </td>
                </tr>

                <tr
                    id={this.props.category + "DescriptionRow"}
                    className={`small-description categoryTableDescription`}
                >
                    <td colSpan={2}>
                        {chrome.i18n.getMessage("category_" + this.props.category + "_description")}
                    </td>
                </tr>

                {this.getExtraOptionComponents(this.props.category)}
            </>
        );
    }

    /**
     * 类别行下方挂载的附加设置。
     * 与 `CategorySkipOptionsComponent.getExtraOptionComponents` 同构：
     * 「疑似 AICG 内容」的阈值/最小长度/调试开关直接长在它自己的类别行下面，
     * 不另起一块独立设置。
     */
    getExtraOptionComponents(category: string): JSX.Element[] {
        const result: JSX.Element[] = [];
        for (const option of this.getExtraOptions(category)) {
            result.push(
                <tr key={option.configKey}>
                    <td id={`${category}_${option.configKey}`} className="categoryExtraOptions" colSpan={3}>
                        {option.type === "number" ? (
                            <label className="number-container">
                                <span className="optionLabel">{option.label}</span>
                                <input
                                    type="number"
                                    step={option.step}
                                    min={option.min}
                                    max={option.max}
                                    defaultValue={Config.config[option.configKey]}
                                    onChange={(event) => {
                                        Config.config[option.configKey] = event.target.value;
                                    }}
                                />
                            </label>
                        ) : (
                            <ToggleOptionComponent
                                configKey={option.configKey}
                                label={option.label}
                                style={{ width: "inherit" }}
                            />
                        )}
                    </td>
                </tr>
            );
        }

        return result;
    }

    getExtraOptions(category: string): ExtraOption[] {
        switch (category) {
            case "dynamicSponsor_aicg":
                return [
                    {
                        type: "number",
                        configKey: "commentAicgThreshold",
                        label: chrome.i18n.getMessage("commentAicgThresholdShort"),
                        step: 0.05,
                        min: 0,
                        max: 1,
                    },
                    {
                        type: "number",
                        configKey: "commentAicgMinLength",
                        label: chrome.i18n.getMessage("commentAicgMinLengthShort"),
                        step: 1,
                        min: 0,
                        max: 200,
                    },
                    {
                        type: "toggle",
                        configKey: "commentAicgDebug",
                        label: chrome.i18n.getMessage("commentAicgDebug"),
                    },
                ];
            default:
                return [];
        }
    }

    skipOptionSelected(event: React.ChangeEvent<HTMLSelectElement>): void {
        let option: DynamicSponsorOption;

        switch (event.target.value) {
            case "disable":
                Config.config.dynamicSponsorSelections = Config.config.dynamicSponsorSelections.filter(
                    (dynamicSponsorSelections) => dynamicSponsorSelections.name !== this.props.category
                );
                return;
            case "showOverlay_DynamicSponsor":
                option = DynamicSponsorOption.ShowOverlay;

                break;
            case "Hide_DynamicSponsor":
                option = DynamicSponsorOption.Hide;

                break;
            case "HideCard_DynamicSponsor":
                option = DynamicSponsorOption.HideCard;

                break;
        }

        const existingSelection = Config.config.dynamicSponsorSelections.find(
            (selection) => selection.name === this.props.category
        );
        if (existingSelection) {
            existingSelection.option = option;
        } else {
            Config.config.dynamicSponsorSelections.push({
                name: this.props.category,
                option: option,
            });
        }

        Config.forceSyncUpdate("dynamicSponsorSelections");
    }

    getCategorySkipOptions(): JSX.Element[] {
        const elements: JSX.Element[] = [];

        // 「疑似 AICG 内容」多一个「隐藏卡片」：整条评论直接不显示。
        const optionNames = this.props.category === "dynamicSponsor_aicg"
            ? ["disable", "showOverlay_DynamicSponsor", "Hide_DynamicSponsor", "HideCard_DynamicSponsor"]
            : ["disable", "showOverlay_DynamicSponsor", "Hide_DynamicSponsor"];

        for (const optionName of optionNames) {
            elements.push(
                <option key={optionName} value={optionName}>
                    {chrome.i18n.getMessage(optionName)}
                </option>
            );
        }

        return elements;
    }

    setColorState(event: React.FormEvent<HTMLInputElement>): void {
        clearTimeout(this.setBarColorTimeout);

        this.setState({
            color: event.currentTarget.value,
        });

        Config.config.dynamicSponsorTypes[this.props.category].color = event.currentTarget.value;


        // Make listener get called
        this.setBarColorTimeout = setTimeout(() => {
            Config.config.dynamicSponsorTypes = Config.config.dynamicSponsorTypes;
        }, 50);
    }
}

export {CategorySkipOptionsComponent, DynamicSponsorHideOptionsComponent}
