// Copyright (C) 2020 Intel Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import { connect } from 'react-redux';
import Icon from 'antd/lib/icon';
import Popover from 'antd/lib/popover';
import Select, { OptionProps } from 'antd/lib/select';
import Button from 'antd/lib/button';
import Modal from 'antd/lib/modal';
import Text from 'antd/lib/typography/Text';
import { Row, Col } from 'antd/lib/grid';
import notification from 'antd/lib/notification';

import { AITools } from 'icons';
import { Canvas } from 'cvat-canvas-wrapper';
import getCore from 'cvat-core-wrapper';
import {
    CombinedState,
    ActiveControl,
    Model,
    ObjectType,
    ShapeType,
} from 'reducers/interfaces';
import { interactWithCanvas, fetchAnnotationsAsync, updateAnnotationsAsync } from 'actions/annotation-actions';
import { InteractionResult } from 'cvat-canvas/src/typescript/canvas';

interface StateToProps {
    canvasInstance: Canvas;
    labels: any[];
    states: any[];
    activeLabelID: number;
    jobInstance: any;
    isInteraction: boolean;
    frame: number;
    interactors: Model[];
}

interface DispatchToProps {
    onInteractionStart(activeInteractor: Model, activeLabelID: number): void;
    updateAnnotations(statesToUpdate: any[]): void;
    fetchAnnotations(): void;
}

const core = getCore();

function mapStateToProps(state: CombinedState): StateToProps {
    const { annotation } = state;
    const { number: frame } = annotation.player.frame;
    const { instance: jobInstance } = annotation.job;
    const { instance: canvasInstance, activeControl } = annotation.canvas;
    const { models } = state;
    const { interactors } = models;

    return {
        interactors,
        isInteraction: activeControl === ActiveControl.INTERACTION,
        activeLabelID: annotation.drawing.activeLabelID,
        labels: annotation.job.labels,
        states: annotation.annotations.states,
        canvasInstance,
        jobInstance,
        frame,
    };
}

function mapDispatchToProps(dispatch: any): DispatchToProps {
    return {
        onInteractionStart(activeInteractor: Model, activeLabelID: number): void {
            dispatch(interactWithCanvas(activeInteractor, activeLabelID));
        },
        updateAnnotations(statesToUpdate: any[]): void {
            dispatch(updateAnnotationsAsync(statesToUpdate));
        },
        fetchAnnotations(): void {
            dispatch(fetchAnnotationsAsync());
        },
    };
}

function convertShapesForInteractor(shapes: InteractionResult[]): number[][] {
    const reducer = (acc: number[][], _: number, index: number, array: number[]): number[][] => {
        if (!(index % 2)) { // 0, 2, 4
            acc.push([
                array[index],
                array[index + 1],
            ]);
        }
        return acc;
    };

    return shapes.filter((shape: InteractionResult): boolean => shape.shapeType === 'points')
        .map((shape: InteractionResult): number[] => shape.points)
        .flat().reduce(reducer, []);
}

type Props = StateToProps & DispatchToProps;
interface State {
    activeInteractor: Model | null;
    activeLabelID: number;
    interactiveStateID: number | null;
    fetching: boolean;
}

class ToolsControlComponent extends React.PureComponent<Props, State> {
    public constructor(props: Props) {
        super(props);
        this.state = {
            activeInteractor: props.interactors.length ? props.interactors[0] : null,
            activeLabelID: props.labels[0].id,
            interactiveStateID: null,
            fetching: false,
        };
    }

    public componentDidMount(): void {
        const { canvasInstance } = this.props;
        canvasInstance.html().addEventListener('canvas.interacted', this.interactionListener);
    }

    public componentDidUpdate(prevProps: Props): void {
        const { isInteraction, jobInstance } = this.props;
        const { interactiveStateID } = this.state;
        if (prevProps.isInteraction && !isInteraction) {
            if (interactiveStateID !== null) {
                jobInstance.actions.freeze(false);
                this.setState({ interactiveStateID: null });
            }
        }
    }

    public componentWillUnmount(): void {
        const { canvasInstance } = this.props;
        canvasInstance.html().removeEventListener('canvas.interacted', this.interactionListener);
    }

    private interactionListener = async (e: Event): Promise<void> => {
        const {
            frame,
            states,
            labels,
            jobInstance,
            isInteraction,
            activeLabelID,
            fetchAnnotations,
            updateAnnotations,
        } = this.props;
        const { activeInteractor, interactiveStateID } = this.state;

        try {
            this.setState({ fetching: true });

            if (!isInteraction) {
                throw Error('Canvas raises "canvas.interacted" when interaction is off');
            }

            const interactor = activeInteractor as Model;
            const result = await core.lambda.call(jobInstance.task, interactor, {
                task: jobInstance.task,
                frame,
                points: convertShapesForInteractor((e as CustomEvent).detail.shapes),
            });

            // no shape yet, then create it and save to collection
            if (interactiveStateID === null) {
                const object = new core.classes.ObjectState({
                    frame,
                    objectType: ObjectType.SHAPE,
                    label: labels
                        .filter((label: any) => label.id === activeLabelID)[0],
                    shapeType: ShapeType.POLYGON,
                    points: result.flat(),
                    occluded: false,
                    zOrder: (e as CustomEvent).detail.zOrder,
                });
                // need a clientID of a created object, so, we do not use createAnnotationAction
                const [clientID] = await jobInstance.annotations.put([object]);

                // update annotations on a canvas
                fetchAnnotations();

                // freeze history for interaction time
                // (points updating shouldn't cause adding new actions to history)
                await jobInstance.actions.freeze(true);
                this.setState({ interactiveStateID: clientID });
            } else {
                const state = states
                    .filter((_state: any): boolean => _state.clientID === interactiveStateID)[0];
                state.points = result.flat();
                await updateAnnotations([state]);
            }
        } catch (err) {
            notification.error({
                description: err.toString(),
                message: 'Interaction error occured',
            });
        } finally {
            this.setState({ fetching: false });
        }
    };

    private setActiveInteractor = (key: string): void => {
        const { interactors } = this.props;
        this.setState({
            activeInteractor: interactors.filter(
                (interactor: Model) => interactor.id === key,
            )[0],
        });
    };

    private setActiveLabel = (key: string): void => {
        const { labels } = this.props;
        this.setState({
            activeLabelID: labels.filter(
                (label: any) => label.id === +key,
            )[0],
        });
    };

    private renderLabelBlock(): JSX.Element {
        const { labels, activeLabelID } = this.props;
        return (
            <>
                <Row type='flex' justify='start'>
                    <Col>
                        <Text className='cvat-text-color'>Label</Text>
                    </Col>
                </Row>
                <Row type='flex' justify='center'>
                    <Col span={24}>
                        <Select
                            style={{ width: '100%' }}
                            showSearch
                            filterOption={
                                (input: string, option: React.ReactElement<OptionProps>) => {
                                    const { children } = option.props;
                                    if (typeof (children) === 'string') {
                                        return children.toLowerCase().includes(input.toLowerCase());
                                    }

                                    return false;
                                }
                            }
                            value={`${activeLabelID}`}
                            onChange={this.setActiveLabel}
                        >
                            {
                                labels.map((label: any) => (
                                    <Select.Option key={label.id} value={`${label.id}`}>
                                        {label.name}
                                    </Select.Option>
                                ))
                            }
                        </Select>
                    </Col>
                </Row>
            </>
        );
    }

    private renderInteractorBlock(): JSX.Element {
        const { interactors, canvasInstance, onInteractionStart } = this.props;
        const { activeInteractor, activeLabelID, fetching } = this.state;

        return (
            <>
                <Row type='flex' justify='start'>
                    <Col>
                        <Text className='cvat-text-color'>Interactor</Text>
                    </Col>
                </Row>
                <Row type='flex' align='middle' justify='center'>
                    <Col span={24}>
                        <Select
                            style={{ width: '100%' }}
                            defaultValue={interactors[0].name}
                            onChange={this.setActiveInteractor}
                        >
                            {interactors.map((interactor: Model): JSX.Element => (
                                <Select.Option title={interactor.description} key={interactor.id}>
                                    {interactor.name}
                                </Select.Option>
                            ))}
                        </Select>
                    </Col>
                </Row>
                <Row type='flex' align='middle' justify='center'>
                    <Col offset={4} span={16}>
                        <Button
                            loading={fetching}
                            className='cvat-tools-interact-button'
                            disabled={!activeInteractor || fetching}
                            onClick={() => {
                                if (activeInteractor) {
                                    canvasInstance.cancel();
                                    canvasInstance.interact({
                                        shapeType: 'points',
                                        minVertices: 4, // TODO: Add parameter to interactor
                                        enabled: true,
                                    });

                                    onInteractionStart(activeInteractor, activeLabelID);
                                }
                            }}
                        >
                            Interact
                        </Button>
                    </Col>
                </Row>
            </>
        );
    }

    private renderPopoverContent(): JSX.Element {
        return (
            <div className='cvat-tools-control-popover-content'>
                <Row type='flex' justify='start'>
                    <Col>
                        <Text className='cvat-text-color' strong>AI Tools</Text>
                    </Col>
                </Row>
                { this.renderLabelBlock() }
                { this.renderInteractorBlock() }
            </div>
        );
    }

    public render(): JSX.Element | null {
        const { interactors, isInteraction, canvasInstance } = this.props;
        const { fetching } = this.state;

        if (!interactors.length) return null;

        const dynamcPopoverPros = isInteraction ? {
            overlayStyle: {
                display: 'none',
            },
        } : {};

        const dynamicIconProps = isInteraction ? {
            className: 'cvat-active-canvas-control cvat-tools-control',
            onClick: (): void => {
                canvasInstance.interact({ enabled: false });
            },
        } : {
            className: 'cvat-tools-control',
        };

        return (
            <>
                <Modal
                    title='Interaction request'
                    zIndex={Number.MAX_SAFE_INTEGER}
                    visible={fetching}
                    closable={false}
                    footer={[]}
                >
                    <Text>Waiting for a server response..</Text>
                    <Icon style={{ marginLeft: '10px' }} type='loading' />
                </Modal>
                <Popover
                    {...dynamcPopoverPros}
                    placement='right'
                    overlayClassName='cvat-tools-control-popover'
                    content={interactors.length && this.renderPopoverContent()}
                >
                    <Icon {...dynamicIconProps} component={AITools} />
                </Popover>
            </>
        );
    }
}

export default connect(
    mapStateToProps,
    mapDispatchToProps,
)(ToolsControlComponent);
