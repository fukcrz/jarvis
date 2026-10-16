import { ChevronRight, Folder } from "lucide-react";
import type { Workspace } from "../../shared/protocol";
import { Dialog, DialogContent } from "./ui/dialog";

interface ProjectPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 全部项目（不受聚焦模式过滤），保证聚焦时也能给任意项目新建会话。 */
  workspaces: Workspace[];
  onPick: (workspaceId: string) => void;
}

/** "新建会话"先选项目的弹窗：移动端会话页和 PC 侧栏共用。 */
export function ProjectPickerDialog(props: ProjectPickerDialogProps) {
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent title="选择项目" className="project-picker-dialog">
      <div className="project-picker">
        {props.workspaces.map((workspace) => <button type="button" key={workspace.id} onClick={() => { props.onOpenChange(false); props.onPick(workspace.id); }}><Folder size={16} /><span>{workspace.label}</span><ChevronRight size={16} /></button>)}
      </div>
    </DialogContent>
  </Dialog>;
}
