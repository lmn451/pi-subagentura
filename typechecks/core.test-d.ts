import { asStringIdentifier, type WorkflowId } from "../src/identifier-types";
import { zeroUsage, type Usage } from "../src/usage";

const ids: readonly WorkflowId[] = [asStringIdentifier<"workflow">("wf-1")];

// @ts-expect-error Indexed access must account for an absent element.
const unchecked: WorkflowId = ids[0];
const checked: WorkflowId | undefined = ids[0];

// @ts-expect-error Optional provenance must be omitted, not explicitly undefined.
const undefinedProvenance: Usage = { ...zeroUsage(), costSource: undefined };
const omittedProvenance: Usage = zeroUsage();
const knownProvenance: Usage = { ...zeroUsage(), costSource: "provider" };

void unchecked;
void checked;
void undefinedProvenance;
void omittedProvenance;
void knownProvenance;
