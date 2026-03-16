"""Code execution engine — subprocess-based Python/R execution.

Ported from inference.py _execute_code_subprocess() (lines 1414-1551).
Runs user code in a subprocess with preamble/postamble for matplotlib patching,
_prev_data.json loading, and auto-save of figures/tables.
"""

import asyncio
import logging
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from langfuse.decorators import observe

from config import get_settings

logger = logging.getLogger("aigen.code_executor")


@dataclass
class CodeExecutionResult:
    """Result of a code execution."""

    success: bool
    stdout: str = ""
    stderr: str = ""
    figures: list[str] = field(default_factory=list)
    tables: list[str] = field(default_factory=list)


class CodeExecutor:
    """Execute Python/R code via subprocess, collect outputs."""

    def __init__(self) -> None:
        self._settings = get_settings()

    @observe(name="Run Sandbox Code") # 이 데코레이터가 실행 정보를 캡처합니다
    async def execute(
        self, code: str, language: str, conv_id: str, step_id: str
    ) -> CodeExecutionResult:
        """Async wrapper — delegates to _execute_sync via thread."""
        return await asyncio.to_thread(
            self._execute_sync, code, language, conv_id, step_id
        )

    # ------------------------------------------------------------------
    # Sync execution (runs in thread pool)
    # ------------------------------------------------------------------

    def _execute_sync(
        self, code: str, language: str, conv_id: str, step_id: str
    ) -> CodeExecutionResult:
        out_dir = os.path.join(
            self._settings.OUTPUTS_DIR, str(conv_id), f"step_{step_id}"
        ).replace("\\", "/")
        os.makedirs(out_dir, exist_ok=True)

        if language == "r":
            ext, cmd_prefix = ".R", ["Rscript"]
            preamble = postamble = ""
        else:
            ext, cmd_prefix = ".py", [sys.executable]
            preamble = self._build_python_preamble(out_dir)
            postamble = self._build_python_postamble(out_dir)

        # Auto-call main() if defined but not invoked
        if language == "python":
            has_main_def = bool(re.search(r"^def\s+main\s*\(", code, re.MULTILINE))
            has_main_call = bool(
                re.search(r"(?:^|\n)(?:if\s+__name__.*)?main\s*\(", code)
            )
            if has_main_def and not has_main_call:
                code += "\n\nmain()\n"

        full_code = preamble + code + postamble

        tmp_file = None
        try:
            tmp_file = tempfile.NamedTemporaryFile(
                mode="w", suffix=ext, delete=False, encoding="utf-8"
            )
            tmp_file.write(full_code)
            tmp_file.close()

            proc = subprocess.run(
                cmd_prefix + [tmp_file.name],
                capture_output=True,
                text=True,
                timeout=60,
                cwd=out_dir,
            )

            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            success = proc.returncode == 0
            logger.info(
                f"[exec] rc={proc.returncode}, "
                f"stdout={len(stdout)}c, stderr={len(stderr)}c, cwd={out_dir}"
            )
            if stderr.strip():
                logger.debug(f"[exec] stderr: {stderr[:300]}")
        except subprocess.TimeoutExpired:
            stdout = ""
            stderr = "Code execution timed out (60s limit)"
            success = False
        except Exception as e:
            stdout = ""
            stderr = str(e)
            success = False
        finally:
            if tmp_file and os.path.exists(tmp_file.name):
                os.unlink(tmp_file.name)

        figures, tables = self._collect_outputs(out_dir, conv_id, step_id)
        return CodeExecutionResult(
            success=success,
            stdout=stdout,
            stderr=stderr,
            figures=figures,
            tables=tables,
        )

    # ------------------------------------------------------------------
    # Preamble / Postamble  (inference.py lines 1432-1491)
    # ------------------------------------------------------------------

    def _build_python_preamble(self, out_dir: str) -> str:
        return (
            "import os as _os\n"
            "import json as _json\n"
            "import matplotlib as _mpl\n"
            "_mpl.use('Agg')\n"
            "import matplotlib.pyplot as _plt\n"
            f"_out_dir = {repr(out_dir)}\n"
            f"_data_dir = {repr(out_dir)}\n"
            "_fig_count = [0]\n"
            "# Load previous step results if available\n"
            "results = {}\n"
            "_prev_path = _os.path.join(_out_dir, '_prev_data.json')\n"
            "if _os.path.isfile(_prev_path):\n"
            "    try:\n"
            "        with open(_prev_path, 'r', encoding='utf-8') as _pf:\n"
            "            _prev_list = _json.load(_pf)\n"
            "        for _item in _prev_list:\n"
            "            _sn = _item.get('step_num', _item.get('step', 0))\n"
            "            results[_sn] = _item.get('result', {}).get('result', _item.get('result', {}))\n"
            "    except Exception:\n"
            "        pass\n"
            "# Patch plt.show to auto-save figures\n"
            "_orig_show = _plt.show\n"
            "def _patched_show(*a, **kw):\n"
            "    _fig_count[0] += 1\n"
            "    _plt.savefig(f'{_out_dir}/fig_{_fig_count[0]}.png', dpi=100, bbox_inches='tight')\n"
            "    _plt.close('all')\n"
            "_plt.show = _patched_show\n"
            "# Patch plt.savefig to also copy to _out_dir\n"
            "_orig_savefig = _plt.savefig\n"
            "def _patched_savefig(fname, *a, **kw):\n"
            "    _orig_savefig(fname, *a, **kw)\n"
            "    if isinstance(fname, str) and not _os.path.isabs(fname):\n"
            "        _fig_count[0] += 1\n"
            "        dest = f'{_out_dir}/fig_{_fig_count[0]}.png'\n"
            "        if _os.path.abspath(fname) != _os.path.abspath(dest):\n"
            "            try:\n"
            "                import shutil as _shutil\n"
            "                _shutil.copy2(_os.path.abspath(fname), dest)\n"
            "            except Exception:\n"
            "                pass\n"
            "_plt.savefig = _patched_savefig\n"
        )

    def _build_python_postamble(self, out_dir: str) -> str:
        return (
            "\n# --- auto-save cleanup ---\n"
            "import matplotlib.pyplot as _plt2\n"
            "if _plt2.get_fignums():\n"
            "    _fig_count[0] += 1\n"
            f"    _plt2.savefig(f'{out_dir}/fig_{{_fig_count[0]}}.png', dpi=100, bbox_inches='tight')\n"
            "    _plt2.close('all')\n"
            "try:\n"
            "    import pandas as _pd\n"
            "    _tbl_count = 0\n"
            "    for _vname, _vval in list(locals().items()):\n"
            "        if isinstance(_vval, _pd.DataFrame) and not _vname.startswith('_'):\n"
            "            _tbl_count += 1\n"
            f"            _vval.to_csv(f'{out_dir}/table_{{_tbl_count}}.csv', index=False)\n"
            "except ImportError:\n"
            "    pass\n"
        )

    # ------------------------------------------------------------------
    # Output collection
    # ------------------------------------------------------------------

    def _collect_outputs(
        self, out_dir: str, conv_id: str, step_id: str
    ) -> tuple[list[str], list[str]]:
        """Scan out_dir for .png (figures) and .csv (tables), return URL paths."""
        figures: list[str] = []
        tables: list[str] = []
        if not os.path.isdir(out_dir):
            return figures, tables

        for f in sorted(os.listdir(out_dir)):
            if f.startswith("_"):
                continue
            url = f"/api/outputs/{conv_id}/step_{step_id}/{f}"
            if f.endswith(".png"):
                figures.append(url)
            elif f.endswith(".csv"):
                tables.append(url)

        logger.debug(f"[exec] outputs: figures={len(figures)}, tables={len(tables)}")
        return figures, tables
