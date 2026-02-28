FROM continuumio/miniconda3

RUN apt-get update && apt-get install -y \
    git build-essential curl wget unzip gcc make jq r-base weasyprint \
    libpango-1.0-0 libharfbuzz0b libpangoft2-1.0-0 \
    && curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.deb.sh | bash \
    && apt-get install -y git-lfs \
    && git lfs install \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN conda install -y -c conda-forge -c bioconda \
    python=3.11 \
    blast samtools bowtie2 bwa bedtools fastqc trimmomatic \
    mafft gseapy mageck plannotate \
    && conda clean -afy

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN pip install "git+https://github.com/YosefLab/popV.git@refs/pull/100/head" \
    && pip install "git+https://github.com/pylabrobot/pylabrobot.git" \
    && pip install uv \
    && uv pip install transcriptformer --system \
    && uv tool install arc-state

RUN Rscript -e "install.packages(c('ggplot2', 'lme4', 'dplyr', 'tidyr', 'readr', 'stringr', 'Matrix', 'Rcpp', 'devtools', 'remotes', 'harmony', 'WGCNA', 'BiocManager'), repos='https://cran.rstudio.com/')" \
    && Rscript -e "BiocManager::install(c('DESeq2', 'dada2', 'xcms', 'flowCore', 'edgeR', 'limma', 'clusterProfiler', 'impute', 'preprocessCore', 'GO.db', 'AnnotationDbi'), ask=FALSE)"

RUN mkdir -p /app/biomni_tools/bin \
    && wget -O /app/biomni_tools/FastTree.c http://www.microbesonline.org/fasttree/FastTree.c \
    && gcc -O3 -finline-functions -funroll-loops -Wall -o /app/biomni_tools/bin/FastTree /app/biomni_tools/FastTree.c -lm \
    && rm -f /app/biomni_tools/FastTree.c
ENV PATH="/app/biomni_tools/bin:${PATH}"

# [핵심 수정 1] Biomni 레포지토리를 도커 이미지 내부로 직접 클론
RUN git clone https://github.com/Science-Will-Win/Biomni.git /app/biomni_repo

RUN opentelemetry-bootstrap -a install

COPY . /app/backend_code
WORKDIR /app/backend_code

# [핵심 수정 2] entrypoint.sh 복사 후 내부에서 직접 줄바꿈 변환(dos2unix 효과) 및 권한 부여
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
