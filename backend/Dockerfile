# 1. 생물정보학 패키지(Conda) 사용을 위해 miniconda3 베이스 이미지 사용
FROM continuumio/miniconda3

# 2. OS 필수 의존성 및 컴파일 툴 설치
RUN apt-get update && apt-get install -y \
    git build-essential curl wget unzip gcc make jq r-base weasyprint \
    libpango-1.0-0 libharfbuzz0b libpangoft2-1.0-0 \
    # git-lfs 설치
    && curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.deb.sh | bash \
    && apt-get install -y git-lfs \
    && git lfs install \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 3. Conda/Bioconda를 통한 생물정보학 CLI 툴 설치
RUN conda install -y -c conda-forge -c bioconda \
    python=3.11 \
    blast samtools bowtie2 bwa bedtools fastqc trimmomatic \
    mafft gseapy mageck plannotate \
    && conda clean -afy

# 4. requirements.txt 기반 Python 패키지 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 5. GitHub 레포지토리 직접 설치 및 고속 설치 툴(uv) 패키지 설치
RUN pip install "git+https://github.com/YosefLab/popV.git@refs/pull/100/head" \
    && pip install "git+https://github.com/pylabrobot/pylabrobot.git" \
    && pip install uv \
    && uv pip install transcriptformer --system \
    && uv tool install arc-state

# 6. R 언어 패키지 설치 (CRAN 및 Bioconductor)
RUN Rscript -e "install.packages(c('ggplot2', 'lme4', 'dplyr', 'tidyr', 'readr', 'stringr', 'Matrix', 'Rcpp', 'devtools', 'remotes', 'harmony', 'WGCNA', 'BiocManager'), repos='https://cran.rstudio.com/')" \
    && Rscript -e "BiocManager::install(c('DESeq2', 'dada2', 'xcms', 'flowCore', 'edgeR', 'limma', 'clusterProfiler', 'impute', 'preprocessCore', 'GO.db', 'AnnotationDbi'), ask=FALSE)"

# 7. 독립 CLI 툴 다운로드 및 컴파일 (FastTree 예시 - 필요시 HOMER 등 추가)
RUN mkdir -p /app/biomni_tools/bin \
    && wget -O /app/biomni_tools/FastTree.c http://www.microbesonline.org/fasttree/FastTree.c \
    && gcc -O3 -finline-functions -funroll-loops -Wall -o /app/biomni_tools/bin/FastTree /app/biomni_tools/FastTree.c -lm \
    && rm -f /app/biomni_tools/FastTree.c
ENV PATH="/app/biomni_tools/bin:${PATH}"

# 8. 소스 코드 복사 및 실행 설정
RUN opentelemetry-bootstrap -a install

COPY . /app/backend_code
WORKDIR /app/backend_code

RUN chmod +x entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/bin/bash", "/app/backend_code/entrypoint.sh"]