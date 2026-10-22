import jenkins.model.Jenkins
import org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition
import org.jenkinsci.plugins.workflow.job.WorkflowJob

def jenkins = Jenkins.get()
def ci = jenkins.getItemByFullName('CloudTool-main')
assert ci != null : 'CloudTool-main does not exist'
def cd = jenkins.getItemByFullName('CloudTool-prod-cd')
if (cd == null) { cd = new WorkflowJob(jenkins, 'CloudTool-prod-cd'); jenkins.add(cd, 'CloudTool-prod-cd') }
def definition = new CpsScmFlowDefinition(ci.definition.scm, 'Jenkinsfile.cd')
definition.setLightweight(true)
cd.setDefinition(definition)
cd.setDescription('Production CD: manually approve promotion of a CI-published immutable image.')
cd.save()
new File('/var/jenkins_home/init.groovy.d/create-cd-job.groovy').delete()
