import { ConfigProvider, Radio } from "antd";
import { CheckboxChangeEvent } from "antd/es/checkbox";
import * as React from "react";
import * as CompileConfig from "../../config.json";
import Config from "../config";
import { keybindToString } from "../config/config";
import { ContentContainer } from "../ContentContainerTypes";
import { showMessage } from "../render/MessageNotice";
import { RectangleTooltip } from "../render/RectangleTooltip";
import { asyncRequestToServer } from "../requests/requests";
import { ActionType, Category, ChannelIDStatus, SponsorTime } from "../types";
import { DEFAULT_CATEGORY } from "../utils/categoryUtils";
import { defaultPreviewTime } from "../utils/constants";
import { getFormattedTime, getFormattedTimeToSeconds } from "../utils/formating";
import { getFrameRate, getVideo } from "../utils/video";
import { SelectorOption } from "./SelectorComponent";
import SubmissionNoticeComponent from "./SubmissionNoticeComponent";
export interface SponsorTimeEditProps {
    index: number;

    idSuffix: string;
    // Contains functions and variables from the content script needed by the skip notice
    contentContainer: ContentContainer;

    submissionNotice: SubmissionNoticeComponent;
    categoryList?: Category[];
    categoryChangeListener?: (index: number, category: Category) => void;
    children?: React.ReactNode;
}

export interface SponsorTimeEditState {
    editing: boolean;
    sponsorTimeEdits: [string, string];
    selectedCategory: Category;
    selectedActionType: ActionType;
    suggestedNames: SelectorOption[];
    chapterNameSelectorOpen: boolean;
    chapterNameSelectorHovering: boolean;
}

class SponsorTimeEditComponent extends React.Component<SponsorTimeEditProps, SponsorTimeEditState> {
    idSuffix: string;

    categoryOptionRef: React.RefObject<HTMLSelectElement>;
    actionTypeOptionRef: React.RefObject<HTMLSelectElement>;
    descriptionOptionRef: React.RefObject<HTMLInputElement>;

    configUpdateListener: () => void;

    previousSkipType: ActionType;
    // Used when selecting POI or Full
    timesBeforeChanging: number[] = [];
    fullVideoWarningShown = false;
    categoryNameWarningShown = false;

    // For description auto-complete
    fetchingSuggestions: boolean;

    constructor(props: SponsorTimeEditProps) {
        super(props);

        this.categoryOptionRef = React.createRef();
        this.actionTypeOptionRef = React.createRef();
        this.descriptionOptionRef = React.createRef();

        this.idSuffix = this.props.idSuffix;
        this.previousSkipType = ActionType.Skip;

        const sponsorTime = this.props.contentContainer().sponsorTimesSubmitting[this.props.index];
        this.state = {
            editing: false,
            sponsorTimeEdits: [null, null],
            selectedCategory: sponsorTime.category ?? (DEFAULT_CATEGORY as Category),
            selectedActionType: sponsorTime.actionType,
            suggestedNames: [],
            chapterNameSelectorOpen: false,
            chapterNameSelectorHovering: false,
        };
    }

    componentDidMount(): void {
        // Prevent inputs from triggering key events
        document.getElementById("sponsorTimeEditContainer" + this.idSuffix).addEventListener("keydown", (e) => {
            e.stopPropagation();
        });

        // Prevent scrolling while changing times
        document
            .getElementById("sponsorTimesContainer" + this.idSuffix)
            .addEventListener("wheel", (e) => e.preventDefault());

        // Add as a config listener
        if (!this.configUpdateListener) {
            this.configUpdateListener = () => this.configUpdate();
            Config.configSyncListeners.push(this.configUpdate.bind(this));
        }

        this.checkToShowFullVideoWarning();
    }

    componentWillUnmount(): void {
        if (this.configUpdateListener) {
            Config.configSyncListeners.splice(Config.configSyncListeners.indexOf(this.configUpdate.bind(this)), 1);
        }
    }

    render(): React.ReactElement {
        this.checkToShowFullVideoWarning();

        const style: React.CSSProperties = {
            textAlign: "center",
        };

        if (this.props.index != 0) {
            style.marginTop = "15px";
        }

        // Create time display
        let timeDisplay: JSX.Element;
        const timeDisplayStyle: React.CSSProperties = {};
        const sponsorTime = this.props.contentContainer().sponsorTimesSubmitting[this.props.index];
        const segment = sponsorTime.segment;
        if (this.state.selectedActionType === ActionType.Full) timeDisplayStyle.display = "none";
        if (this.state.editing) {
            timeDisplay = (
                <div
                    id={"sponsorTimesContainer" + this.idSuffix}
                    style={timeDisplayStyle}
                    className="sponsorTimeDisplay"
                >
                    <span className="sponsorTimeStackButton">
                        <span
                            id={"nowButton0" + this.idSuffix}
                            className="sponsorNowButton"
                            onClick={() => this.setTimeToNow(0)}
                        >
                            {chrome.i18n.getMessage("bracketNow")}
                        </span>

                        {this.state.selectedActionType !== ActionType.Poi ? (
                            <span
                                id={"startButton" + this.idSuffix}
                                className="sponsorNowButton"
                                onClick={() => this.setTimeTo(0, 0)}
                            >
                                {chrome.i18n.getMessage("bracketStart")}
                            </span>
                        ) : (
                            ""
                        )}
                    </span>

                    <input
                        id={"submittingTime0" + this.idSuffix}
                        className="sponsorTimeEdit sponsorTimeEditInput"
                        type="text"
                        style={{ color: "inherit", backgroundColor: "inherit" }}
                        value={this.state.sponsorTimeEdits[0] ?? ""}
                        onKeyDown={(e) => e.stopPropagation()}
                        onKeyUp={(e) => e.stopPropagation()}
                        onChange={(e) => this.handleOnChange(0, e, sponsorTime, e.target.value)}
                        onWheel={(e) => this.changeTimesWhenScrolling(0, e, sponsorTime)}
                    ></input>

                    {this.state.selectedActionType !== ActionType.Poi ? (
                        <>
                            <span>{" " + chrome.i18n.getMessage("to") + " "}</span>

                            <input
                                id={"submittingTime1" + this.idSuffix}
                                className="sponsorTimeEdit sponsorTimeEditInput"
                                type="text"
                                style={{ color: "inherit", backgroundColor: "inherit" }}
                                value={this.state.sponsorTimeEdits[1] ?? ""}
                                onKeyDown={(e) => e.stopPropagation()}
                                onKeyUp={(e) => e.stopPropagation()}
                                onChange={(e) => this.handleOnChange(1, e, sponsorTime, e.target.value)}
                                onWheel={(e) => this.changeTimesWhenScrolling(1, e, sponsorTime)}
                            ></input>

                            <span className="sponsorTimeStackButton">
                                <span
                                    id={"nowButton1" + this.idSuffix}
                                    className="sponsorNowButton"
                                    onClick={() => this.setTimeToNow(1)}
                                >
                                    {chrome.i18n.getMessage("bracketNow")}
                                </span>

                                <span
                                    id={"endButton" + this.idSuffix}
                                    className="sponsorNowButton"
                                    onClick={() => this.setTimeToEnd()}
                                >
                                    {chrome.i18n.getMessage("bracketEnd")}
                                </span>
                            </span>
                        </>
                    ) : (
                        ""
                    )}
                </div>
            );
        } else {
            timeDisplay = (
                <div
                    id={"sponsorTimesContainer" + this.idSuffix}
                    style={timeDisplayStyle}
                    className="sponsorTimeDisplay"
                    onClick={this.toggleEditTime.bind(this)}
                >
                    {getFormattedTime(segment[0], true) +
                        (!isNaN(segment[1]) && this.state.selectedActionType !== ActionType.Poi
                            ? " " + chrome.i18n.getMessage("to") + " " + getFormattedTime(segment[1], true)
                            : "")}
                </div>
            );
        }

        return (
            <div id={"sponsorTimeEditContainer" + this.idSuffix} style={style}>
                {timeDisplay}

                {/* Category */}
                <div style={{ position: "relative" }}>
                    <select
                        id={"sponsorTimeCategories" + this.idSuffix}
                        className="sponsorTimeEditSelector sponsorTimeCategories"
                        ref={this.categoryOptionRef}
                        style={{ color: "inherit", backgroundColor: "inherit" }}
                        value={this.state.selectedCategory}
                        onChange={(event) => this.categorySelectionChange(event)}
                    >
                        {this.getCategoryOptions()}
                    </select>

                    {/* open in new tab */}
                    <a
                        href={
                            CompileConfig.wikiLinks[sponsorTime.category] ||
                            "https://github.com/hanydd/BilibiliSponsorBlock/wiki"
                        }
                        target="_blank"
                        rel="noreferrer"
                    >
                        <img
                            id={"sponsorTimeCategoriesHelpButton" + this.idSuffix}
                            className="helpButton"
                            src={chrome.runtime.getURL("icons/help.svg")}
                            title={chrome.i18n.getMessage("categoryGuidelines")}
                        />
                    </a>
                </div>

                {/* Action Type */}
                {CompileConfig.categorySupport[sponsorTime.category] &&
                (CompileConfig.categorySupport[sponsorTime.category]?.length > 1 ||
                    CompileConfig.categorySupport[sponsorTime.category]?.[0] === ActionType.Full) ? (
                    <div style={{ position: "relative", margin: "5px 0" }}>
                        <ConfigProvider theme={{ token: { colorPrimary: "#00aeec", fontSize: 12 } }}>
                            <Radio.Group
                                optionType="button"
                                buttonStyle="solid"
                                size="small"
                                options={this.getActionTypeOption(sponsorTime)}
                                value={this.state.selectedActionType}
                                onChange={(e) => this.actionTypeSRadioChange(e)}
                            />
                        </ConfigProvider>
                    </div>
                ) : (
                    ""
                )}

                {/* Editing Tools */}

                <div style={{ marginTop: "8px" }}>
                    <span
                        id={"sponsorTimeDeleteButton" + this.idSuffix}
                        className="sponsorTimeEditButton"
                        onClick={this.deleteTime.bind(this)}
                    >
                        {chrome.i18n.getMessage("delete")}
                    </span>

                    {!isNaN(segment[1]) &&
                    ![ActionType.Poi, ActionType.Full].includes(this.state.selectedActionType) ? (
                        <span
                            id={"sponsorTimePreviewButton" + this.idSuffix}
                            className="sponsorTimeEditButton"
                            {...(Config.config.previewKeybind && {
                                title: `${chrome.i18n.getMessage("preview")} (${keybindToString(
                                    Config.config.previewKeybind
                                )})`,
                            })}
                            onClick={(e) => this.previewTime(e.ctrlKey, e.shiftKey)}
                        >
                            {chrome.i18n.getMessage("preview")}
                        </span>
                    ) : (
                        ""
                    )}

                    {!isNaN(segment[1]) && this.state.selectedActionType != ActionType.Full ? (
                        <span
                            id={"sponsorTimeInspectButton" + this.idSuffix}
                            className="sponsorTimeEditButton"
                            onClick={this.inspectTime.bind(this)}
                        >
                            {chrome.i18n.getMessage("inspect")}
                        </span>
                    ) : (
                        ""
                    )}

                    {!isNaN(segment[1]) &&
                    ![ActionType.Poi, ActionType.Full].includes(this.state.selectedActionType) ? (
                        <span
                            id={"sponsorTimePreviewEndButton" + this.idSuffix}
                            className="sponsorTimeEditButton"
                            onClick={(e) => this.previewTime(e.ctrlKey, e.shiftKey, true)}
                        >
                            {chrome.i18n.getMessage("End")}
                        </span>
                    ) : (
                        ""
                    )}

                    {!isNaN(segment[1]) && this.state.selectedActionType != ActionType.Full ? (
                        <span
                            id={"sponsorTimeEditButton" + this.idSuffix}
                            className="sponsorTimeEditButton"
                            onClick={this.toggleEditTime.bind(this)}
                        >
                            {this.state.editing ? chrome.i18n.getMessage("save") : chrome.i18n.getMessage("edit")}
                        </span>
                    ) : (
                        ""
                    )}
                </div>
            </div>
        );
    }

    handleOnChange(index: number, e: React.ChangeEvent, sponsorTime: SponsorTime, targetValue: string): void {
        const sponsorTimeEdits = this.state.sponsorTimeEdits;

        // check if change is small engough to show tooltip
        const before = getFormattedTimeToSeconds(sponsorTimeEdits[index]);
        const after = getFormattedTimeToSeconds(targetValue);
        const difference = Math.abs(before - after);
        if (0 < difference && difference < 0.5) this.showScrollToEditToolTip();

        sponsorTimeEdits[index] = targetValue;
        if (index === 0 && sponsorTime.actionType === ActionType.Poi) sponsorTimeEdits[1] = targetValue;

        this.setState({ sponsorTimeEdits }, () => this.saveEditTimes());
    }

    changeTimesWhenScrolling(index: number, e: React.WheelEvent, sponsorTime: SponsorTime): void {
        e.stopPropagation();
        if (!Config.config.allowScrollingToEdit) return;

        // shift = 1s
        // ctrl = ~0.2s (round up whole frame)
        // default = 1 frame ()
        const frameRate = getFrameRate();
        let step: number;
        if (e.shiftKey) {
            step = 1;
        } else if (e.ctrlKey) {
            step = Math.ceil(frameRate * 0.2) / frameRate;
        } else {
            step = 1 / frameRate;
        }

        const sponsorTimeEdits = this.state.sponsorTimeEdits;
        let timeAsNumber = getFormattedTimeToSeconds(this.state.sponsorTimeEdits[index]);
        if (timeAsNumber !== null && e.deltaY != 0) {
            if (e.deltaY < 0) {
                timeAsNumber += step;
            } else if (timeAsNumber >= step) {
                timeAsNumber -= step;
            } else {
                timeAsNumber = 0;
            }

            sponsorTimeEdits[index] = getFormattedTime(timeAsNumber, true);
            if (sponsorTime.actionType === ActionType.Poi) sponsorTimeEdits[1] = sponsorTimeEdits[0];

            this.setState({ sponsorTimeEdits });
            this.saveEditTimes();
        }
    }

    showScrollToEditToolTip(): void {
        if (
            !Config.config.scrollToEditTimeUpdate &&
            document.getElementById("sponsorRectangleTooltip" + "sponsorTimesContainer" + this.idSuffix) === null
        ) {
            this.showToolTip(chrome.i18n.getMessage("SponsorTimeEditScrollNewFeature"), "scrollToEdit", () => {
                Config.config.scrollToEditTimeUpdate = true;
            });
        }
    }

    showToolTip(text: string, id: string, buttonFunction?: () => void): boolean {
        const element = document.getElementById("sponsorTimesContainer" + this.idSuffix);
        if (element) {
            const htmlId = `sponsorRectangleTooltip${id + this.idSuffix}`;
            if (!document.getElementById(htmlId)) {
                new RectangleTooltip({
                    text,
                    referenceNode: element.parentElement,
                    prependElement: element,
                    timeout: 15,
                    bottomOffset: 0 + "px",
                    leftOffset: -318 + "px",
                    backgroundColor: "rgba(28, 28, 28, 1.0)",
                    htmlId,
                    buttonFunction,
                    fontSize: "14px",
                    maxHeight: "200px",
                });
            }

            return true;
        } else {
            return false;
        }
    }

    checkToShowFullVideoWarning(): void {
        const sponsorTime = this.props.contentContainer().sponsorTimesSubmitting[this.props.index];
        const segmentDuration = sponsorTime.segment[1] - sponsorTime.segment[0];
        const videoPercentage = segmentDuration / getVideo().duration;

        if (
            videoPercentage > 0.6 &&
            !this.fullVideoWarningShown &&
            (sponsorTime.category === "sponsor" ||
                sponsorTime.category === "selfpromo" ||
                sponsorTime.category === "chooseACategory")
        ) {
            if (this.showToolTip(chrome.i18n.getMessage("fullVideoTooltipWarning"), "fullVideoWarning")) {
                this.fullVideoWarningShown = true;
            }
        }
    }

    getCategoryOptions(): React.ReactElement[] {
        const elements = [
            <option value={DEFAULT_CATEGORY} key={DEFAULT_CATEGORY}>
                {chrome.i18n.getMessage(DEFAULT_CATEGORY)}
            </option>,
        ];

        for (const category of this.props.categoryList ?? CompileConfig.categoryList) {
            //仅本地展示不可提交
            if (category === "filtered_category") continue;

            // If permission not loaded, treat it like we have permission except chapter
            const permission =
                Config.config.showCategoryWithoutPermission || Config.config.permissions[category as Category];
            if (permission !== undefined && !Config.config.showCategoryWithoutPermission && !permission) continue;

            elements.push(
                <option value={category} key={category} className={this.getCategoryLockedClass(category)}>
                    {chrome.i18n.getMessage("category_" + category)}
                </option>
            );
        }

        return elements;
    }

    getCategoryLockedClass(category: string): string {
        return this.props.contentContainer().lockedCategories.includes(category) ? "sponsorBlockLockedColor" : "";
    }

    categorySelectionChange(event: React.ChangeEvent<HTMLSelectElement>): void {
        const chosenCategory = event.target.value as Category;
        this.setState({
            selectedCategory: chosenCategory,
        });

        // See if show more categories was pressed
        if (
            chosenCategory !== DEFAULT_CATEGORY &&
            !Config.config.categorySelections.some((category) => category.name === chosenCategory)
        ) {
            event.target.value = DEFAULT_CATEGORY;

            // Alert that they have to enable this category first
            if (
                confirm(
                    chrome.i18n
                        .getMessage("enableThisCategoryFirst")
                        .replace("{0}", chrome.i18n.getMessage("category_" + chosenCategory))
                )
            ) {
                // Open options page
                chrome.runtime.sendMessage({ message: "openConfig", hash: "behavior" });
            }

            return;
        }

        const sponsorTime = this.props.contentContainer().sponsorTimesSubmitting[this.props.index];
        this.handleReplacingLostTimes(chosenCategory, sponsorTime.actionType, sponsorTime);
        this.saveEditTimes();

        if (this.props.categoryChangeListener) {
            this.props.categoryChangeListener(this.props.index, chosenCategory);
        }
    }

    actionTypeSRadioChange(event: CheckboxChangeEvent): void {
        const sponsorTime = this.props.contentContainer().sponsorTimesSubmitting[this.props.index];

        const actionType = event.target.value as ActionType;
        this.setState({
            selectedActionType: actionType,
        });

        this.handleReplacingLostTimes(sponsorTime.category, actionType, sponsorTime);
        this.saveEditTimes(actionType);
    }

    private handleReplacingLostTimes(category: Category, actionType: ActionType, segment: SponsorTime): void {
        if (CompileConfig.categorySupport[category]?.includes(ActionType.Poi)) {
            if (this.previousSkipType !== ActionType.Poi) {
                this.timesBeforeChanging = [null, segment.segment[1]];
            }

            this.setTimeTo(1, null);
            this.props.contentContainer().updateEditButtonsOnPlayer();

            if (
                this.props
                    .contentContainer()
                    .sponsorTimesSubmitting.some(
                        (segment, i) => segment.category === category && i !== this.props.index
                    )
            ) {
                showMessage(chrome.i18n.getMessage("poiOnlyOneSegment"), "warning");
            }

            this.previousSkipType = ActionType.Poi;
        } else if (
            CompileConfig.categorySupport[category]?.length === 1 &&
            CompileConfig.categorySupport[category]?.[0] === ActionType.Full
        ) {
            if (this.previousSkipType !== ActionType.Full) {
                this.timesBeforeChanging = [...segment.segment];
            }

            this.previousSkipType = ActionType.Full;
        } else if (
            (category === "chooseACategory" ||
                (CompileConfig.categorySupport[category]?.includes(ActionType.Skip) &&
                    ![ActionType.Poi, ActionType.Full].includes(this.getNextActionType(category, actionType)))) &&
            this.previousSkipType !== ActionType.Skip
        ) {
            if (this.timesBeforeChanging[0]) {
                this.setTimeTo(0, this.timesBeforeChanging[0]);
            }
            if (this.timesBeforeChanging[1]) {
                this.setTimeTo(1, this.timesBeforeChanging[1]);
            }

            this.previousSkipType = ActionType.Skip;
        }
    }

    getActionTypeOption(sponsorTime: SponsorTime) {
        const options = [];
        for (const actionType of CompileConfig.categorySupport[sponsorTime.category]) {
            options.push({ label: chrome.i18n.getMessage(actionType), value: actionType });
        }
        if (options.length === 0) {
            return [{ label: "", value: "" }];
        }
        return options;
    }

    setTimeToNow(index: number): void {
        this.setTimeTo(index, this.props.contentContainer().getRealCurrentTime());
    }

    setTimeToEnd(): void {
        this.setTimeTo(1, getVideo().duration);
    }

    /**
     * @param index
     * @param time If null, will set time to the first index's time
     */
    setTimeTo(index: number, time: number): void {
        const sponsorTime = this.props.contentContainer().sponsorTimesSubmitting[this.props.index];
        if (time === null) time = sponsorTime.segment[0];

        const addedTime = sponsorTime.segment.length === 1;
        sponsorTime.segment[index] = time;
        if (sponsorTime.actionType === ActionType.Poi) sponsorTime.segment[1] = time;

        if (addedTime) {
            this.props.contentContainer().updateEditButtonsOnPlayer();
        }

        this.setState(
            {
                sponsorTimeEdits: this.getFormattedSponsorTimesEdits(sponsorTime),
            },
            () => this.saveEditTimes()
        );
    }

    toggleEditTime(): void {
        if (this.state.editing) {
            this.setState({
                editing: false,
            });

            this.saveEditTimes();
        } else {
            const sponsorTime = this.props.contentContainer().sponsorTimesSubmitting[this.props.index];

            this.setState({
                editing: true,
                sponsorTimeEdits: this.getFormattedSponsorTimesEdits(sponsorTime),
            });
        }
    }

    /** Returns an array in the sponsorTimeEdits form (formatted time string) from a normal seconds sponsor time */
    getFormattedSponsorTimesEdits(sponsorTime: SponsorTime): [string, string] {
        return [getFormattedTime(sponsorTime.segment[0], true), getFormattedTime(sponsorTime.segment[1], true)];
    }

    lastEditTime = 0;
    editTimeTimeout: NodeJS.Timeout | null = null;
    saveEditTimes(action = this.state.selectedActionType): void {
        // Rate limit edits
        const timeSinceLastEdit = Date.now() - this.lastEditTime;
        const rateLimitTime = 200;
        if (timeSinceLastEdit < rateLimitTime) {
            if (!this.editTimeTimeout) {
                this.editTimeTimeout = setTimeout(() => {
                    this.saveEditTimes(action);
                }, rateLimitTime - timeSinceLastEdit);
            }

            return;
        }

        this.lastEditTime = Date.now();
        this.editTimeTimeout = null;

        const sponsorTimesSubmitting = this.props.contentContainer().sponsorTimesSubmitting;
        const category = this.categoryOptionRef.current.value as Category;

        if (this.state.editing) {
            const startTime = getFormattedTimeToSeconds(this.state.sponsorTimeEdits[0]);
            const endTime = getFormattedTimeToSeconds(this.state.sponsorTimeEdits[1]);

            // Change segment time only if the format was correct
            if (startTime !== null && endTime !== null) {
                const addingTime = sponsorTimesSubmitting[this.props.index].segment.length === 1;
                sponsorTimesSubmitting[this.props.index].segment = [startTime, endTime];

                if (addingTime) {
                    this.props.contentContainer().updateEditButtonsOnPlayer();
                }
            } else if (startTime !== null) {
                // Only start time is valid, still an incomplete segment
                sponsorTimesSubmitting[this.props.index].segment[0] = startTime;
            }
        } else if (
            this.state.sponsorTimeEdits[1] === null &&
            category === "outro" &&
            !sponsorTimesSubmitting[this.props.index].segment[1]
        ) {
            sponsorTimesSubmitting[this.props.index].segment[1] = getVideo().duration;
            this.props.contentContainer().updateEditButtonsOnPlayer();
        }

        sponsorTimesSubmitting[this.props.index].category = category;

        const actionType = this.getNextActionType(category, action);
        sponsorTimesSubmitting[this.props.index].actionType = actionType;
        this.setState({
            selectedActionType: actionType,
        });

        Config.local.unsubmittedSegments[this.props.contentContainer().sponsorVideoID] = sponsorTimesSubmitting;
        Config.forceLocalUpdate("unsubmittedSegments");

        this.props.contentContainer().updatePreviewBar();

        if (
            sponsorTimesSubmitting[this.props.index].actionType === ActionType.Full &&
            (sponsorTimesSubmitting[this.props.index].segment[0] !== 0 ||
                sponsorTimesSubmitting[this.props.index].segment[1] !== 0)
        ) {
            this.setTimeTo(0, 0);
            this.setTimeTo(1, 0);
        }
    }

    private getNextActionType(category: Category, actionType: ActionType): ActionType {
        return actionType && CompileConfig.categorySupport[category]?.includes(actionType)
            ? actionType
            : CompileConfig.categorySupport[category]?.[0] ?? ActionType.Skip;
    }

    previewTime(ctrlPressed = false, shiftPressed = false, skipToEndTime = false): void {
        const sponsorTimes = this.props.contentContainer().sponsorTimesSubmitting;
        const index = this.props.index;
        let seekTime = defaultPreviewTime;
        if (ctrlPressed) seekTime = 0.5;
        if (shiftPressed) seekTime = 0.25;

        const startTime = sponsorTimes[index].segment[0];
        const endTime = sponsorTimes[index].segment[1];

        // If segment starts at 0:00, start playback at the end of the segment
        const skipTime = startTime === 0 || skipToEndTime ? endTime : startTime - seekTime * getVideo().playbackRate;

        this.props.contentContainer().previewTime(skipTime, !skipToEndTime);
    }

    inspectTime(): void {
        const sponsorTimes = this.props.contentContainer().sponsorTimesSubmitting;
        const index = this.props.index;

        const skipTime = sponsorTimes[index].segment[0];

        this.props.contentContainer().previewTime(skipTime + 0.0001, false);
    }

    deleteTime(): void {
        const sponsorTimes = this.props.contentContainer().sponsorTimesSubmitting;
        const index = this.props.index;
        const removingIncomplete = sponsorTimes[index].segment.length < 2;

        sponsorTimes.splice(index, 1);

        //save this
        if (sponsorTimes.length > 0) {
            Config.local.unsubmittedSegments[this.props.contentContainer().sponsorVideoID] = sponsorTimes;
        } else {
            delete Config.local.unsubmittedSegments[this.props.contentContainer().sponsorVideoID];
        }
        Config.forceLocalUpdate("unsubmittedSegments");

        this.props.contentContainer().updatePreviewBar();

        //if they are all removed
        if (sponsorTimes.length == 0) {
            this.props.submissionNotice.cancel();
        } else {
            //update display
            this.props.submissionNotice.forceUpdate();
        }

        //if it is not a complete segment, or all are removed
        if (sponsorTimes.length === 0 || removingIncomplete) {
            //update video player
            this.props.contentContainer().updateEditButtonsOnPlayer();
        }
    }

    async fetchSuggestions(description: string): Promise<void> {
        if (this.props.contentContainer().channelIDInfo.status !== ChannelIDStatus.Found) return;

        this.fetchingSuggestions = true;
        const result = await asyncRequestToServer("GET", "/api/chapterNames", {
            description,
            channelID: this.props.contentContainer().channelIDInfo.id,
        });

        if (result.ok) {
            try {
                const names = JSON.parse(result.responseText) as { description: string }[];
                this.setState({
                    suggestedNames: names.map((n) => ({
                        label: n.description,
                    })),
                });
            } catch (e) {} //eslint-disable-line no-empty
        }

        this.fetchingSuggestions = false;
    }

    configUpdate(): void {
        this.forceUpdate();
    }
}

export default SponsorTimeEditComponent;
